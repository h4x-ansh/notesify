import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NotesSchema, geminiNotesSchema } from "./schema.js";

const SYSTEM_PROMPT = `You are a meticulous note-taker for exam aspirants.
Transform the given lecture transcript into detailed, structured, exam-ready notes.

Rules:
- Stay 100% grounded in the transcript. Never invent facts, examples, or numbers that are not present or directly implied.
- Do not skip any definition, formula, law, date, diagram description, or exam-relevant point mentioned in the transcript.
- Write bullets that are short and revision-friendly, not verbatim transcript sentences.
- Use "highlights" for the specific keywords/values inside a section's bullets that deserve a highlighter mark (formulas, key terms, final answers, dates).
- Use "callout" only when the transcript content clearly warrants an exam tip, a commonly made mistake, or a "must remember" point. Do not force one onto every section.
- Use "formula" (KaTeX syntax) whenever the transcript states a standalone formula or equation.
- Any inline math inside "bullets", "callout.text", or table cells - LaTeX commands (\hat{i}, \sin\theta, \implies), subscripts (N_AB, S_{abs}), superscripts (t^2, \sin^2\theta), or any other LaTeX syntax - must be wrapped in $...$ delimiters. Never leave raw LaTeX un-delimited in prose text.
- Use "table" when the transcript compares multiple items (e.g. sign conventions, unit systems) - otherwise omit it.
- Paginate: group 2-4 related sections per page so no page is overloaded. Prefer more pages over cramming.
- If the transcript is ambiguous or garbled in a spot, note it plainly rather than guessing at content.`;

// Gemini gets schema-constrained output natively (generationConfig.responseSchema
// below), so it doesn't need this spelled out in prose. Groq's OpenAI-compatible
// API only guarantees *valid JSON* via response_format: json_object, not
// adherence to a particular shape - without this, nothing stops it from
// inventing its own reasonable-looking-but-different structure. The zod
// validation in parseAndValidate() is still the real gate either way; this
// just makes a first-try schema match far more likely from a model family
// that isn't natively schema-constrained.
const JSON_SHAPE_INSTRUCTIONS = `Respond with ONLY a raw JSON object - no markdown, no code fences, no commentary before or after - matching exactly this shape:
{
  "title": string,
  "subject": string,
  "pages": [
    {
      "sections": [
        {
          "subheading": string,
          "bullets": string[],
          "highlights": string[],
          "formula": string or null,
          "table": { "headers": string[], "rows": string[][] } or null,
          "callout": { "type": "Exam Tip" | "Common Mistake" | "Important" | "Must Remember" | "Memory Trick", "text": string } or null
        }
      ]
    }
  ]
}
"formula", "table", and "callout" are optional per section - use null or omit when not warranted, never force one in.`;

// English is the default/omitted case - no instruction added, so an old
// request with no `language` field (or one explicitly set to "English")
// behaves exactly as before this feature existed. Only a non-English
// selection appends this. Explicit about the LaTeX boundary since
// "translate everything" is exactly wrong for `\hat{i}`, `N_AB`, etc. -
// those are syntax, not prose, and translating a variable name or command
// would just break KaTeX rendering downstream (see template.js).
function languageInstruction(language) {
  if (!language || language === "English") return "";
  return `\n\nIMPORTANT: Write the entire output - every title, subheading, bullet, callout, and table cell - in ${language}. Keep all LaTeX/math notation (formulas, inline $...$ math, commands like \\hat{i} or \\sin\\theta, subscripts, superscripts, variable names) exactly as valid LaTeX syntax - do not translate or transliterate anything inside math notation. Only the surrounding explanatory prose should be in ${language}, not English.`;
}

function buildUserPrompt(transcript, title, language) {
  const base = title ? `Lecture title hint: "${title}"\n\nTranscript:\n${transcript}` : `Transcript:\n${transcript}`;
  return base + languageInstruction(language);
}

function parseAndValidate(raw, providerLabel) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${providerLabel} did not return valid JSON for the structured notes.`);
  }

  const parsed = NotesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Structured notes from ${providerLabel} failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * 429/quota-exceeded, or a 404 "model not found/no longer available"
 * response - the two failure modes where retrying the *same* provider (or
 * even the same model string) would never succeed, so advancing to the
 * next provider is the only thing that could actually help. Everything
 * else (malformed transcript, a provider's output failing zod validation,
 * network errors, auth errors) is a real problem that trying a different
 * provider wouldn't fix either, so those still fail loudly and immediately
 * instead of being masked by more (doomed) attempts.
 *
 * The 404 case isn't hypothetical - it's exactly what happened when
 * gemini-2.5-flash-lite's model string went stale: Google started
 * returning "This model models/gemini-2.5-flash-lite is no longer
 * available to new users" as a 404 (`GoogleGenerativeAIFetchError.status`,
 * set from the HTTP response status - see @google/generative-ai's fetch
 * error class), and the chain didn't advance to Groq at all because only
 * 429s counted as fall-through triggers - a failure a different provider
 * would have trivially recovered from instead surfaced as a hard error.
 * Scoped to messages that actually say the model is unavailable/deprecated/
 * not found, not just any 404, so an unrelated 404 (a real bug in this
 * codebase, a moved endpoint) still fails loudly rather than being masked.
 */
function isFallThroughError(err) {
  if (err?.status === 429) return true; // groq-sdk (and most HTTP client errors) set this
  if (err?.name === "RateLimitError") return true; // groq-sdk's typed error class
  const message = err?.message || String(err);
  if (/\b429\b|quota|rate.?limit|resource.?exhausted|too many requests/i.test(message)) return true;

  if (err?.status === 404 || /\b404\b/.test(message)) {
    return /model|no longer available|not found|deprecated/i.test(message);
  }
  return false;
}

async function generateWithGemini(transcript, title, modelName, language) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiNotesSchema,
    },
  });

  const result = await model.generateContent(buildUserPrompt(transcript, title, language));
  return parseAndValidate(result.response.text(), modelName);
}

async function generateWithGroq(transcript, title, language) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set - cannot use Groq as a fallback provider.");
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${JSON_SHAPE_INSTRUCTIONS}` },
      { role: "user", content: buildUserPrompt(transcript, title, language) },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Groq returned an empty response.");
  return parseAndValidate(raw, "groq-llama-3.3-70b");
}

/**
 * Gemini's free tier caps out fast (gemini-2.5-flash: ~20 requests/day),
 * so a single busy day of testing/use exhausts it - already happened
 * repeatedly during this project's own hosted testing (see the README's
 * Gemini quota note). Priority order, each step only reached if the
 * previous one hit a quota error specifically:
 *
 * 1. gemini-2.5-flash - best quality, current primary.
 * 2. gemini-3.1-flash-lite - same Google account/API key, a separate quota
 *    bucket, same native responseSchema support - a same-family swap, not
 *    a different integration. (Was gemini-2.5-flash-lite; Google returned
 *    a 404 "no longer available to new users" for that model string as of
 *    July 2026 - gemini-3.1-flash-lite is the current stable lightweight
 *    model per ai.google.dev/gemini-api/docs/models.)
 * 3. groq-llama-3.3-70b - a genuinely separate provider/account
 *    (GROQ_API_KEY), ~14,400 RPD free-tier headroom. Different model
 *    family, no native JSON-schema constraining on Groq's side - leans on
 *    JSON_SHAPE_INSTRUCTIONS in the prompt plus the same zod validation
 *    every provider's output goes through either way.
 */
export async function generateNotes(transcript, { title, language } = {}) {
  const providers = [
    {
      label: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      run: () => generateWithGemini(transcript, title, process.env.GEMINI_MODEL || "gemini-2.5-flash", language),
    },
    { label: "gemini-3.1-flash-lite", run: () => generateWithGemini(transcript, title, "gemini-3.1-flash-lite", language) },
    { label: "groq-llama-3.3-70b", run: () => generateWithGroq(transcript, title, language) },
  ];

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const notes = await provider.run();
      if (i > 0) {
        console.log(`[notesGenerator] generated via fallback provider: ${provider.label}`);
      }
      return notes;
    } catch (err) {
      const isLast = i === providers.length - 1;
      if (!isFallThroughError(err)) {
        // Not a quota/model-unavailable problem - a different provider
        // wouldn't fix it either, so surface it immediately instead of
        // masking it behind more (doomed) attempts.
        throw err;
      }
      console.error(
        `[notesGenerator] ${provider.label} hit a quota/rate-limit or model-unavailable error${isLast ? "" : ", trying next provider"}:`,
        err.message
      );
      if (isLast) {
        throw new Error("All note-generation providers are currently rate-limited or unavailable. Try again later.");
      }
    }
  }
}
