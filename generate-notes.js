#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { runPipeline } from "./src/pipeline.js";

const program = new Command();

function logUpdate(patch) {
  if (patch.meta?.transcriptLength) {
    console.log(`  got ${patch.meta.transcriptLength} chars via ${patch.meta.transcriptSource}`);
    return;
  }
  if (patch.meta?.notesTitle) {
    console.log(`  "${patch.meta.notesTitle}" — ${patch.meta.pageCount} page(s)`);
    return;
  }
  switch (patch.stage) {
    case "extracting_transcript":
      console.log("→ Fetching transcript...");
      break;
    case "generating_notes":
      console.log("→ Generating structured notes with Gemini...");
      break;
    case "rendering_pdf":
      console.log("→ Rendering handwritten notebook template...");
      console.log("→ Exporting PDF...");
      break;
  }
}

program
  .name("generate-notes")
  .description("Turn a YouTube lecture into handwritten topper's-notebook style PDF notes")
  .argument("<youtube-url>", "YouTube video URL")
  .option("-o, --output <path>", "output PDF path", "notes.pdf")
  .option("--keep-html", "also write the intermediate HTML file next to the PDF")
  .option("--keep-json", "also write the intermediate structured notes JSON")
  .action(async (url, opts) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in.");
      }

      const outputPath = path.resolve(opts.output);
      const result = await runPipeline(url, outputPath, { onUpdate: logUpdate });

      if (opts.keepJson) {
        const jsonPath = outputPath.replace(/\.pdf$/i, ".json");
        await writeFile(jsonPath, JSON.stringify(result.notes, null, 2), "utf-8");
        console.log(`  wrote ${jsonPath}`);
      }

      if (opts.keepHtml) {
        const htmlPath = outputPath.replace(/\.pdf$/i, ".html");
        await writeFile(htmlPath, result.html, "utf-8");
        console.log(`  wrote ${htmlPath}`);
      }

      const t = result.timings;
      console.log(
        `  [pdf timing] setContent=${t.setContent.toFixed(0)}ms fonts+settle=${t.fontsAndSettle.toFixed(0)}ms print=${t.print.toFixed(0)}ms total=${t.total.toFixed(0)}ms`
      );
      console.log(`✓ Done: ${outputPath}`);
    } catch (err) {
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
    }
  });

program.parse();
