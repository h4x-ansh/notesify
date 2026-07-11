import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NotesSchema, geminiNotesSchema } from "./schema.js";
import { attachTimestamps } from "./timestampMatcher.js";

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

// Appended to SYSTEM_PROMPT for the fallback providers only (Groq's Llama
// 70B, and gemini-3.1-flash-lite) - never for the primary gemini-2.5-flash,
// which is already producing good depth on the base prompt alone. Smaller/
// lighter models tend to under-elaborate on the same instructions -
// summarizing sparsely instead of preserving the source's actual level of
// detail - so the fallback path spells out the "don't summarize" framing
// explicitly rather than assuming it's implied by "detailed, structured,
// exam-ready notes" in SYSTEM_PROMPT. The JSON shape/schema requirements
// are deliberately untouched by this - only the depth/thoroughness framing
// differs between providers, never the output contract.
//
// The quantified guidance below (bullet counts, "walk through step by
// step") was added after investigating a real report that Groq's output
// still read short even with this instruction in place - confirmed via a
// real call that this was never a token-limit/truncation issue
// (finish_reason: "stop", well under Groq's model max, and see
// generateWithGroq's comment on why an explicit max_completion_tokens is
// actively the wrong fix here) - Llama was choosing brevity, not being cut
// off. A vaguer "include more detail" framing left that choice to the
// model's own judgment; concrete numbers/actions leave less room for a
// model that defaults to terse to interpret its way back to a short answer.
const THOROUGHNESS_INSTRUCTIONS = `
Additional emphasis: do not summarize sparsely. Include all examples, sub-points, and elaborations present in the source material. Err on the side of more detail per section, not less. Match the depth and thoroughness of a comprehensive study guide, not a brief summary.
Aim for at least 4-6 bullets per section whenever the source material supports it - do not compress multiple distinct points into a single bullet. If the transcript walks through a worked example or a multi-step process, break it into separate bullets for each step rather than one summary line. When unsure whether a sub-point is worth including, include it rather than cut it.
Do not hit this bullet count by padding with generic restatements - each bullet must carry a specific, distinct fact, number, formula, or step from the transcript. Preserve every concrete detail the source gives: named formulas (in LaTeX), specific values, technical terms, and named examples. Still use "callout" and "formula" wherever the transcript content warrants one - more bullets is not a reason to drop them.`;

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

async function generateWithGemini(transcript, title, modelName, language, { thorough = false } = {}) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: thorough ? `${SYSTEM_PROMPT}\n${THOROUGHNESS_INSTRUCTIONS}` : SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiNotesSchema,
    },
  });

  const result = await model.generateContent(buildUserPrompt(transcript, title, language));
  return parseAndValidate(result.response.text(), modelName);
}

// Deliberately no explicit `max_completion_tokens` here - checked directly
// against a real call (see README's Groq output-depth investigation):
// finish_reason came back "stop", not "length", with completion_tokens
// (~1100-1300 for a ~33K-char transcript) well under Llama 3.3 70B's real
// 8192-token ceiling - the shorter-than-Gemini output was never a
// truncation problem. Explicitly raising max_completion_tokens toward that
// ceiling was tried and made things *worse*: Groq's free-tier TPM (tokens
// per minute) limit counts the requested max toward the same budget as
// prompt_tokens, so requesting a high completion budget on top of an
// already-substantial prompt triggered a real 413 "Request too large...
// TPM Limit 12000" rejection that omitting the parameter entirely doesn't
// hit. The actual fix for terse output is prompt wording (see
// THOROUGHNESS_INSTRUCTIONS' quantified guidance), not a token cap.
async function generateWithGroq(transcript, title, language, { thorough = false } = {}) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set - cannot use Groq as a fallback provider.");
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}${thorough ? `\n${THOROUGHNESS_INSTRUCTIONS}` : ""}\n\n${JSON_SHAPE_INSTRUCTIONS}`,
      },
      { role: "user", content: buildUserPrompt(transcript, title, language) },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Groq returned an empty response.");
  return parseAndValidate(raw, "groq-llama-3.3-70b");
}

// The note-quality tier picker (see the frontend's picker screen) - each
// tier maps to its own provider list, not a shared cascade. This is a
// deliberate change from the single three-step cascade that used to apply
// unconditionally: a user who explicitly picked "High" chose to wait for
// (or be told no about) gemini-2.5-flash specifically, and silently
// downgrading them to Groq/Flash-Lite would defeat the entire point of
// having picked it - so High never cascades. Symmetrically, "Normal"
// cascading all the way *up* into High would let a Normal-tier request
// quietly consume gemini-2.5-flash's much scarcer daily quota, which is
// exactly what tiering is meant to prevent. Each tier is its own closed
// world:
//
// - **High** -> gemini-2.5-flash only (`GEMINI_MODEL` overridable), no
//   thoroughness framing (doesn't need it), no cascade at all.
// - **Normal** (default) -> groq-llama-3.3-70b first, cascading to
//   gemini-3.1-flash-lite if Groq fails - the same two-step order this
//   file used as its universal fallback chain before tiering existed, now
//   scoped to just this tier. Both steps get THOROUGHNESS_INSTRUCTIONS.
// - **Low** -> gemini-3.1-flash-lite only, thoroughness framing still
//   applied (it's the same lightweight model regardless of which tier
//   routes to it), no further cascade - it's already the cheapest/last-
//   resort model, there's nowhere lower to fall to.
//
// Thoroughness is decided per tier, not by hardcoding it to a specific
// model's identity - notice gemini-3.1-flash-lite gets `thorough: true`
// in both the Normal and Low tiers below (the same reasoning applies
// regardless of which tier routed to it), while gemini-2.5-flash never
// does. If a future tier remix pointed a different model at a given tier,
// its thoroughness would follow from that assignment, not from a
// hardcoded model-name check.
function buildProvidersForTier(tier, transcript, title, language) {
  const geminiPrimary = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  switch (tier) {
    case "High":
      return [{ label: geminiPrimary, run: () => generateWithGemini(transcript, title, geminiPrimary, language, { thorough: false }) }];
    case "Low":
      return [
        {
          label: "gemini-3.1-flash-lite",
          run: () => generateWithGemini(transcript, title, "gemini-3.1-flash-lite", language, { thorough: true }),
        },
      ];
    case "Normal":
    default:
      return [
        { label: "groq-llama-3.3-70b", run: () => generateWithGroq(transcript, title, language, { thorough: true }) },
        {
          label: "gemini-3.1-flash-lite",
          run: () => generateWithGemini(transcript, title, "gemini-3.1-flash-lite", language, { thorough: true }),
        },
      ];
  }
}

// Shown when a tier's entire provider list is exhausted (its one provider
// failed for High/Low, or both steps failed for Normal) - specific enough
// that a user knows exactly what to do next, rather than a generic "try
// again later" that doesn't tell them switching tiers would actually help
// right now.
function tierExhaustedMessage(tier) {
  switch (tier) {
    case "High":
      return "High quality is unavailable right now (daily limit reached). Try Normal or Low, or wait until tomorrow.";
    case "Low":
      return "Low quality is unavailable right now. Try Normal or High, or wait until tomorrow.";
    case "Normal":
    default:
      return "Normal quality is unavailable right now (daily limit reached on both providers). Try High or Low, or wait until tomorrow.";
  }
}

/**
 * `qualityTier` selects which provider list applies (see
 * buildProvidersForTier above) - "Normal" when omitted/unrecognized, the
 * same default the picker screen itself defaults to. Whichever provider
 * in the selected tier's list actually produces the notes is returned
 * alongside them as `providerUsed`, with `cascaded: true` when it wasn't
 * the tier's first choice (only possible for Normal, the only tier with
 * more than one step) - see pipeline.js, which surfaces this in job
 * metadata for the "done" screen.
 *
 * `segments` (optional - see transcript.js/pipeline.js) never reaches any
 * provider's prompt - it's applied once, after whichever provider's output
 * has already passed schema validation, via attachTimestamps() (see
 * timestampMatcher.js). Deliberately outside the provider loop/retry logic:
 * it's a pure post-processing step over the final notes, independent of
 * which provider produced them or how many fallback attempts it took.
 */
export async function generateNotes(transcript, { title, language, segments, qualityTier } = {}) {
  const tier = qualityTier === "High" || qualityTier === "Low" ? qualityTier : "Normal";
  const providers = buildProvidersForTier(tier, transcript, title, language);

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const notes = await provider.run();
      if (i > 0) {
        console.log(`[notesGenerator] generated via fallback provider: ${provider.label}`);
      }
      return { notes: attachTimestamps(notes, segments), providerUsed: provider.label, cascaded: i > 0 };
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
        throw new Error(tierExhaustedMessage(tier));
      }
    }
  }
}
