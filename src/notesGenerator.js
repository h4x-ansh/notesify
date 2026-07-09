import { GoogleGenerativeAI } from "@google/generative-ai";
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

export async function generateNotes(transcript, { title } = {}) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: geminiNotesSchema,
    },
  });

  const userPrompt = title
    ? `Lecture title hint: "${title}"\n\nTranscript:\n${transcript}`
    : `Transcript:\n${transcript}`;

  const result = await model.generateContent(userPrompt);
  const raw = result.response.text();

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Gemini did not return valid JSON for the structured notes.");
  }

  const parsed = NotesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Structured notes failed schema validation: ${parsed.error.message}`);
  }

  return parsed.data;
}
