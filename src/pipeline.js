import path from "node:path";
import { mkdir } from "node:fs/promises";
import { getTranscript } from "./transcript.js";
import { generateNotes } from "./notesGenerator.js";
import { renderNotesHtml } from "./template.js";
import { exportHtmlToPdf } from "./pdfExport.js";
import { classifyError, PipelineError } from "./errors.js";
import { resolvePlaylistVideoUrls, fetchVideoTitle } from "./playlist.js";

// Applied after resolving a playlist to its actual video list (yt-dlp's
// --flat-playlist has to run before the count is known - see
// resolvePlaylistVideoUrls) - a caller pointing at a 200-video playlist
// should get a clear rejection, not a bill for 200 Gemini-input transcripts
// merged into one call. server.js separately caps a direct `videoUrls[]`
// array at request-validation time (MAX_BATCH_VIDEOS, currently 25); this
// is the playlist-specific equivalent, enforced here instead since it can
// only be checked after resolution.
const MAX_PLAYLIST_VIDEOS = 20;

/**
 * Fetches each video's transcript in order via the existing single-video
 * getTranscript() (unchanged - same captions-then-yt-dlp/Whisper fallback
 * per video), reporting per-video progress rather than one opaque stage.
 * Progress is spread across 5-25% (the same range extracting_transcript
 * already used for a single video) so the overall stage progression stays
 * identical regardless of batch size.
 *
 * Policy for a single video failing within the batch: skip it and continue
 * with the rest, rather than failing the whole batch over one bad video -
 * a 5-video batch shouldn't produce zero notes because video 3 has captions
 * disabled. Every skip is recorded with its reason so it surfaces in job
 * metadata (see runPipeline below), not silently dropped.
 */
async function fetchAndMergeTranscripts(urls, onUpdate) {
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    onUpdate({
      stage: "extracting_transcript",
      progress: 5 + Math.round((i / urls.length) * 20),
      meta: { batchProgress: `Fetching video ${i + 1} of ${urls.length}...` },
    });

    const title = await fetchVideoTitle(url);
    try {
      const { text, source } = await getTranscript(url);
      results.push({ url, title, text, source });
    } catch (err) {
      console.error(`[pipeline] skipping video in batch (${url}):`, err.message);
      results.push({ url, title, skipped: true, reason: err.message });
    }
  }

  return results;
}

/**
 * Combines the successful transcripts into one input for the Gemini call,
 * with a clear section marker per video - without this, concatenating
 * several unrelated lecture transcripts back to back would read as one
 * long, incoherent wall of text with no signal to the model about where
 * one video ends and the next begins, making anything resembling sensible
 * per-topic organization unlikely.
 */
function mergeTranscripts(results) {
  return results
    .filter((r) => !r.skipped)
    .map((r, i) => `--- Video ${i + 1}: ${r.title} ---\n${r.text}`)
    .join("\n\n");
}

function summarizeSkipped(results) {
  return results
    .filter((r) => r.skipped)
    .map((r) => ({ url: r.url, title: r.title, reason: r.reason }));
}

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
 *
 * `videoUrls`/`playlistUrl` are the "multiple videos" flow (see the
 * mode-choice/multi-link frontend work and server.js's /generate) - the
 * same overall stage progression (extracting_transcript -> generating_notes
 * -> rendering_pdf -> done) applies, but extracting_transcript now covers
 * fetching+merging N transcripts instead of one. `youtubeUrl` is unused in
 * this branch (server.js passes null for it) - kept as the first positional
 * param rather than folded into the options object to avoid changing every
 * existing single-video call site.
 *
 * `language`/`styleId` are the language+style picker (see the frontend's
 * new picker screen) - passed straight through to generateNotes()
 * (notesGenerator.js appends a language instruction to the prompt, English/
 * unset is a no-op) and renderNotesHtml() (template.js swaps a CSS-variable
 * color preset, unset/unknown falls back to the original "classic" colors).
 * Both apply the same way regardless of single-video/batch/playlist source.
 */
export async function runPipeline(
  youtubeUrl,
  outputPath,
  {
    onUpdate = () => {},
    preFetchedTranscript = null,
    videoUrls = null,
    playlistUrl = null,
    language = null,
    styleId = null,
  } = {}
) {
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });

    let transcript, source;
    let skippedVideos = [];

    if (playlistUrl) {
      onUpdate({ stage: "extracting_transcript", progress: 5, meta: { batchProgress: "Resolving playlist..." } });
      const urls = await resolvePlaylistVideoUrls(playlistUrl, { maxVideos: MAX_PLAYLIST_VIDEOS });

      const results = await fetchAndMergeTranscripts(urls, onUpdate);
      const successCount = results.length - results.filter((r) => r.skipped).length;
      if (successCount === 0) {
        throw new PipelineError("Couldn't get a transcript for any video in this playlist.", "transcript_unavailable");
      }
      transcript = mergeTranscripts(results);
      source = "playlist-merged";
      skippedVideos = summarizeSkipped(results);
    } else if (videoUrls) {
      const results = await fetchAndMergeTranscripts(videoUrls, onUpdate);
      const successCount = results.length - results.filter((r) => r.skipped).length;
      if (successCount === 0) {
        throw new PipelineError("Couldn't get a transcript for any of the provided videos.", "transcript_unavailable");
      }
      transcript = mergeTranscripts(results);
      source = "batch-merged";
      skippedVideos = summarizeSkipped(results);
    } else if (preFetchedTranscript) {
      ({ text: transcript, source } = preFetchedTranscript);
    } else {
      onUpdate({ stage: "extracting_transcript", progress: 5 });
      ({ text: transcript, source } = await getTranscript(youtubeUrl));
    }

    onUpdate({
      stage: "extracting_transcript",
      progress: 25,
      meta: {
        transcriptSource: source,
        transcriptLength: transcript.length,
        // Only present when non-empty, so single-video jobs (the vast
        // majority) don't carry a dead `skippedVideos: []` field in their
        // status forever.
        ...(skippedVideos.length > 0 ? { skippedVideos } : {}),
      },
    });

    onUpdate({ stage: "generating_notes", progress: 35 });
    const notes = await generateNotes(transcript, { language });
    onUpdate({
      stage: "generating_notes",
      progress: 65,
      meta: { notesTitle: notes.title, pageCount: notes.pages.length },
    });

    onUpdate({ stage: "rendering_pdf", progress: 75 });
    const html = renderNotesHtml(notes, { styleId });
    const timings = await exportHtmlToPdf(html, outputPath);

    onUpdate({ stage: "done", progress: 100, outputPath, timings });

    return { transcript, transcriptSource: source, notes, html, outputPath, timings };
  } catch (err) {
    // The raw error can carry a Gemini/Groq SDK message (internal URLs,
    // quota metric names, model IDs) or a zod dump with schema paths -
    // none of that should reach an HTTP client (see server.js's /generate,
    // the only consumer of onUpdate's patches that's actually network-
    // facing). Full detail is preserved server-side two ways: the rethrow
    // below is untouched (the CLI's own catch in generate-notes.js still
    // sees the real message), and server.js's fire-and-forget .catch() on
    // this call logs err.message from that same rethrow.
    const { code, message } = classifyError(err);
    onUpdate({ stage: "error", error: message, errorCode: code });
    throw err;
  }
}
