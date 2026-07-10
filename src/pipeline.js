import path from "node:path";
import { mkdir } from "node:fs/promises";
import { getTranscript } from "./transcript.js";
import { generateNotes } from "./notesGenerator.js";
import { renderNotesHtml } from "./template.js";
import { exportHtmlToPdf } from "./pdfExport.js";

/**
 * Runs transcript extraction -> Gemini notes generation -> template render
 * -> Puppeteer PDF export, end to end. This is the single place that wires
 * the four pipeline modules together; both the CLI (generate-notes.js) and
 * the Express API (server.js) call this directly rather than going through
 * HTTP or duplicating the sequencing themselves.
 *
 * `onUpdate` is called after every stage transition with a partial patch
 * (stage/progress plus stage-specific metadata). The CLI turns these into
 * console lines; the API forwards them straight into the job store so
 * GET /status/:jobId reflects progress in near-real-time.
 *
 * `preFetchedTranscript` lets a caller skip getTranscript() entirely when
 * the transcript was already fetched elsewhere - specifically, client-side
 * in the browser/WebView (see server.js's /generate and the frontend's
 * lib/transcript.ts), done to dodge Render's blocked IP for caption
 * fetches. When absent (client-side fetch wasn't attempted, or failed),
 * this falls through to the exact same server-side captions-then-yt-dlp
 * flow as before - the yt-dlp/Whisper fallback stays server-side either way.
 */
export async function runPipeline(youtubeUrl, outputPath, { onUpdate = () => {}, preFetchedTranscript = null } = {}) {
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });

    let transcript, source;
    if (preFetchedTranscript) {
      ({ text: transcript, source } = preFetchedTranscript);
    } else {
      onUpdate({ stage: "extracting_transcript", progress: 5 });
      ({ text: transcript, source } = await getTranscript(youtubeUrl));
    }
    onUpdate({
      stage: "extracting_transcript",
      progress: 25,
      meta: { transcriptSource: source, transcriptLength: transcript.length },
    });

    onUpdate({ stage: "generating_notes", progress: 35 });
    const notes = await generateNotes(transcript);
    onUpdate({
      stage: "generating_notes",
      progress: 65,
      meta: { notesTitle: notes.title, pageCount: notes.pages.length },
    });

    onUpdate({ stage: "rendering_pdf", progress: 75 });
    const html = renderNotesHtml(notes);
    const timings = await exportHtmlToPdf(html, outputPath);

    onUpdate({ stage: "done", progress: 100, outputPath, timings });

    return { transcript, transcriptSource: source, notes, html, outputPath, timings };
  } catch (err) {
    onUpdate({ stage: "error", error: err.message });
    throw err;
  }
}
