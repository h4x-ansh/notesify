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

function buildUserPrompt(transcript, title) {
  return title ? `Lecture title hint: "${title}"\n\nTranscript:\n${transcript}` : `Transcript:\n${transcript}`;
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
 * 429/quota-exceeded specifically - the one failure mode that should
 * advance to the next provider in the chain. Everything else (malformed
 * transcript, a provider's output failing zod validation, network errors,
 * auth errors) is a real problem that trying a different provider wouldn't
 * fix, so it should fail loudly and immediately rather than being masked
 * by silently falling through.
 */
function isQuotaError(err) {
  if (err?.status === 429) return true; // groq-sdk (and most HTTP client errors) set this
  if (err?.name === "RateLimitError") return true; // groq-sdk's typed error class
  const message = err?.message || String(err);
  return /\b429\b|quota|rate.?limit|resource.?exhausted|too many requests/i.test(message);
}

async function generateWithGemini(transcript, title, modelName) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiNotesSchema,
    },
  });

  const result = await model.generateContent(buildUserPrompt(transcript, title));
  return parseAndValidate(result.response.text(), modelName);
}

async function generateWithGroq(transcript, title) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set - cannot use Groq as a fallback provider.");
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${JSON_SHAPE_INSTRUCTIONS}` },
      { role: "user", content: buildUserPrompt(transcript, title) },
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
 * 2. gemini-2.5-flash-lite - same Google account/API key, a separate
 *    ~1,000 RPD quota bucket, same native responseSchema support - a
 *    same-family swap, not a different integration.
 * 3. groq-llama-3.3-70b - a genuinely separate provider/account
 *    (GROQ_API_KEY), ~14,400 RPD free-tier headroom. Different model
 *    family, no native JSON-schema constraining on Groq's side - leans on
 *    JSON_SHAPE_INSTRUCTIONS in the prompt plus the same zod validation
 *    every provider's output goes through either way.
 */
export async function generateNotes(transcript, { title } = {}) {
  const providers = [
    { label: process.env.GEMINI_MODEL || "gemini-2.5-flash", run: () => generateWithGemini(transcript, title, process.env.GEMINI_MODEL || "gemini-2.5-flash") },
    { label: "gemini-2.5-flash-lite", run: () => generateWithGemini(transcript, title, "gemini-2.5-flash-lite") },
    { label: "groq-llama-3.3-70b", run: () => generateWithGroq(transcript, title) },
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
      if (!isQuotaError(err)) {
        // Not a quota problem - a different provider wouldn't fix it
        // either, so surface it immediately instead of masking it behind
        // more (doomed) attempts.
        throw err;
      }
      console.error(
        `[notesGenerator] ${provider.label} hit a quota/rate-limit error${isLast ? "" : ", trying next provider"}:`,
        err.message
      );
      if (isLast) {
        throw new Error("All note-generation providers are currently rate-limited. Try again later.");
      }
    }
  }
}
