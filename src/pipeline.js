import path from "node:path";
import { mkdir } from "node:fs/promises";
import { getTranscript } from "./transcript.js";
import { generateNotes } from "./notesGenerator.js";
import { renderNotesHtml } from "./template.js";
import { exportHtmlToPdf } from "./pdfExport.js";
import { classifyError, PipelineError } from "./errors.js";
import { resolvePlaylistVideoUrls, fetchVideoTitle, PLAYLIST_CHUNK_SIZE } from "./playlist.js";

// Applied after resolving a playlist to its actual video list (yt-dlp's
// --flat-playlist has to run before the count is known - see
// resolvePlaylistVideoUrls) - a caller pointing at a 200-video playlist
// should get a clear rejection, not a bill for 200 Gemini-input transcripts
// merged into one call. server.js separately caps a direct `videoUrls[]`
// array at request-validation time (MAX_BATCH_VIDEOS, currently 25).
//
// This single-job cap only applies when runPipeline is called directly with
// a playlistUrl (CLI/programmatic use, or a playlist that already fits in
// one chunk) - server.js's /generate route now resolves+auto-chunks larger
// playlists itself (see src/playlist.js's chunkPlaylistVideos) and calls
// this function once per chunk via `videoUrls` instead, so a chunked
// playlist never actually hits this branch/cap at all.
const MAX_PLAYLIST_VIDEOS = PLAYLIST_CHUNK_SIZE;

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
async function fetchAndMergeTranscripts(urls, onUpdate, preFetchedTranscripts = null) {
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    onUpdate({
      stage: "extracting_transcript",
      progress: 5 + Math.round((i / urls.length) * 20),
      meta: { batchProgress: `Fetching video ${i + 1} of ${urls.length}...` },
    });

    const title = await fetchVideoTitle(url);
    // Mirrors the single-video preFetchedTranscript check below - a video
    // the client already fetched captions for client-side (see the
    // frontend's per-video prefetch loop) skips getTranscript() entirely,
    // same reasoning as the single-video path: use the client's own IP
    // instead of this server's (Render's, when hosted), which YouTube has
    // been blocking. Missing/empty entries fall through to the exact same
    // server-side captions-then-yt-dlp/Whisper flow as before, per video.
    // `segments` (video-relative timing, when available - see
    // transcript.js/mergeSegments below) rides along the same way as text/
    // source, whichever path produced it.
    const preFetched = preFetchedTranscripts?.[url];
    if (preFetched?.text) {
      results.push({
        url,
        title,
        text: preFetched.text,
        source: preFetched.source || "captions-client",
        segments: preFetched.segments,
      });
      continue;
    }

    try {
      const { text, source, segments } = await getTranscript(url);
      results.push({ url, title, text, source, segments });
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

/**
 * Flattens each successful video's segments into one list for
 * timestampMatcher.js, tagging every segment with the same 1-based video
 * index/title mergeTranscripts uses in its own `--- Video N: ... ---`
 * markers - so a section's matched timestamp can always be traced back to
 * exactly one video's own timeline, never ambiguous about which video
 * "18:02" refers to in a merged multi-video transcript (each video's
 * segments are independently 0-based, relative to its own start).
 *
 * A video with no segments at all (Whisper fallback - see transcript.js -
 * or a client-side fetch that didn't produce timing data) simply
 * contributes nothing here; its own content just won't get matched to a
 * timestamp, the graceful-degradation behavior timestampMatcher.js already
 * has for a single video with no segments, applied per-video in a batch.
 */
function mergeSegments(results) {
  const merged = [];
  let videoIndex = 0;
  for (const r of results) {
    if (r.skipped) continue;
    videoIndex++;
    for (const seg of r.segments || []) {
      merged.push({ ...seg, videoIndex, videoTitle: r.title });
    }
  }
  return merged;
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
 *
 * `qualityTier` (High/Normal/Low, same picker screen) selects which
 * provider list generateNotes() uses - see notesGenerator.js's
 * buildProvidersForTier for the actual mapping/cascade rules per tier.
 * Unset/unrecognized defaults to Normal there, not here - this function
 * just passes the raw value through. `notesProvider`/`providerCascaded`
 * in the `generating_notes` update below surface which provider actually
 * answered and whether the tier's own cascade kicked in, for the "done"
 * screen to show when it's not the tier's straightforward single provider.
 *
 * `preFetchedTranscripts` (plural, distinct from the single-video
 * `preFetchedTranscript` above) is the batch/playlist equivalent - a map of
 * video URL -> {text, source, segments} for whichever videos the client
 * already fetched captions for itself (see the frontend's per-video
 * prefetch loop, added to close the same Render-IP-blocking gap the
 * single-video path already solved). Passed straight through to
 * fetchAndMergeTranscripts, which checks it per video before falling back
 * to getTranscript().
 *
 * `segments` (video-relative caption timing - see transcript.js's
 * normalizeSegments) flows alongside `transcript`/`source` from whichever
 * branch produced it - a single video's own segments as-is, or
 * mergeSegments' video-tagged flattening for a batch/playlist - and is
 * handed to generateNotes() for the timestamp-matching step (see
 * timestampMatcher.js). Naturally absent (undefined) whenever the source
 * didn't have per-segment timing to begin with (the Whisper fallback,
 * or a client-side fetch that didn't produce it) - generateNotes()
 * degrades gracefully to notes with no timestamps in that case, not an
 * error.
 */
export async function runPipeline(
  youtubeUrl,
  outputPath,
  {
    onUpdate = () => {},
    preFetchedTranscript = null,
    preFetchedTranscripts = null,
    videoUrls = null,
    playlistUrl = null,
    language = null,
    styleId = null,
    qualityTier = null,
  } = {}
) {
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });

    let transcript, source, segments;
    let skippedVideos = [];

    if (playlistUrl) {
      onUpdate({ stage: "extracting_transcript", progress: 5, meta: { batchProgress: "Resolving playlist..." } });
      const urls = await resolvePlaylistVideoUrls(playlistUrl, { maxVideos: MAX_PLAYLIST_VIDEOS });

      const results = await fetchAndMergeTranscripts(urls, onUpdate, preFetchedTranscripts);
      const successCount = results.length - results.filter((r) => r.skipped).length;
      if (successCount === 0) {
        throw new PipelineError("Couldn't get a transcript for any video in this playlist.", "transcript_unavailable");
      }
      transcript = mergeTranscripts(results);
      segments = mergeSegments(results);
      source = "playlist-merged";
      skippedVideos = summarizeSkipped(results);
    } else if (videoUrls) {
      const results = await fetchAndMergeTranscripts(videoUrls, onUpdate, preFetchedTranscripts);
      const successCount = results.length - results.filter((r) => r.skipped).length;
      if (successCount === 0) {
        throw new PipelineError("Couldn't get a transcript for any of the provided videos.", "transcript_unavailable");
      }
      transcript = mergeTranscripts(results);
      segments = mergeSegments(results);
      source = "batch-merged";
      skippedVideos = summarizeSkipped(results);
    } else if (preFetchedTranscript) {
      ({ text: transcript, source, segments } = preFetchedTranscript);
    } else {
      onUpdate({ stage: "extracting_transcript", progress: 5 });
      ({ text: transcript, source, segments } = await getTranscript(youtubeUrl));
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
    const { notes, providerUsed, cascaded } = await generateNotes(transcript, { language, segments, qualityTier });
    onUpdate({
      stage: "generating_notes",
      progress: 65,
      meta: {
        notesTitle: notes.title,
        pageCount: notes.pages.length,
        notesProvider: providerUsed,
        // Only present when true - a straightforward single-provider tier
        // (High, Low, or Normal succeeding on its first try) shouldn't
        // carry a dead `providerCascaded: false` field in its status
        // forever, same reasoning as `skippedVideos` above.
        ...(cascaded ? { providerCascaded: true } : {}),
      },
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
