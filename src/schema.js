import { z } from "zod";
import { SchemaType } from "@google/generative-ai";

const Callout = z.object({
  type: z.enum(["Exam Tip", "Common Mistake", "Important", "Must Remember", "Memory Trick"]),
  text: z.string(),
});

const Table = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const Section = z.object({
  subheading: z.string(),
  bullets: z.array(z.string()).default([]),
  highlights: z.array(z.string()).default([]),
  formula: z.string().nullable().optional(),
  table: Table.nullable().optional(),
  callout: Callout.nullable().optional(),
});

const Page = z.object({
  sections: z.array(Section).min(1),
});

export const NotesSchema = z.object({
  title: z.string(),
  subject: z.string().optional().default(""),
  pages: z.array(Page).min(1),
});

/**
 * Gemini's generateContent supports constrained JSON output directly via
 * generationConfig.responseSchema (no tool-forcing trick needed). This
 * mirrors NotesSchema so the model's raw JSON output can be zod-validated
 * before it reaches the renderer.
 */
export const geminiNotesSchema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING, description: "Lecture/chapter title" },
    subject: { type: SchemaType.STRING, description: "Subject/unit label, e.g. 'Physics • Unit II'" },
    pages: {
      type: SchemaType.ARRAY,
      description: "Notebook pages, pre-paginated so no single page is overloaded (aim for 2-4 sections per page).",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          sections: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                subheading: { type: SchemaType.STRING },
                bullets: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                highlights: {
                  type: SchemaType.ARRAY,
                  items: { type: SchemaType.STRING },
                  description: "Key terms/facts from this section's bullets that should be visually highlighted.",
                },
                formula: { type: SchemaType.STRING, description: "Optional KaTeX string, e.g. 'W = Fs\\\\cos\\\\theta'" },
                table: {
                  type: SchemaType.OBJECT,
                  properties: {
                    headers: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                    rows: { type: SchemaType.ARRAY, items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } } },
                  },
                },
                callout: {
                  type: SchemaType.OBJECT,
                  properties: {
                    type: {
                      type: SchemaType.STRING,
                      enum: ["Exam Tip", "Common Mistake", "Important", "Must Remember", "Memory Trick"],
                    },
                    text: { type: SchemaType.STRING },
                  },
                },
              },
              required: ["subheading", "bullets"],
            },
          },
        },
        required: ["sections"],
      },
    },
  },
  required: ["title", "pages"],
};
