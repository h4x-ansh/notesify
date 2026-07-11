/**
 * Attaches a timestamp reference to each generated section by matching its
 * content back to the transcript segments it most likely came from - a
 * deterministic, code-side word-overlap match, not something asked of the
 * model itself. Model-reported timestamps would risk hallucination just
 * like any other model output (nothing stops a model from confidently
 * inventing a plausible-looking "12:34" that has no relation to the actual
 * video), so this never appears in the Gemini/Groq prompt or schema at all
 * (see notesGenerator.js/schema.js) - it's applied as a post-processing
 * step over already-validated notes, using the real segment timing data
 * the transcript layer preserved (see transcript.js's normalizeSegments
 * and pipeline.js's mergeSegments).
 */

const MIN_WORD_LENGTH = 3;
// A real match should share more than one incidental word - one shared
// short/common word is easy to hit by chance across an entire transcript,
// so a single-word "match" is treated the same as no match at all rather
// than attaching a low-confidence, possibly-wrong timestamp.
const MIN_MATCH_SCORE = 2;
// How far around the best-matching segment to look for a wider range - a
// section's content plausibly spans a few sentences of speech, not the
// video's whole runtime, so this is deliberately tight rather than pulling
// in any other segment that happens to share a word.
const RANGE_WINDOW_SECONDS = 60;
// Below this, showing a "start–end" range adds no real information over
// just the anchor point (YouTube caption segments are only a few seconds
// each), so a single timestamp is shown instead.
const MIN_RANGE_SPAN_SECONDS = 5;

// \p{L}/\p{N} (Unicode letter/number properties, `u` flag) rather than
// [a-z0-9] - this app generates notes in Hindi/Tamil/Bengali (see the
// language picker) and transcripts themselves can be in any script
// (confirmed against a real Korean-language video during testing) - an
// ASCII-only pattern would silently tokenize every non-Latin-script
// segment to zero words, making every section in a non-English transcript
// fail to match anything, not degrade gracefully for the right reason.
function tokenize(text) {
  if (!text) return [];
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= MIN_WORD_LENGTH);
}

function sectionText(section) {
  const parts = [section.subheading, ...(section.bullets || []), section.formula, section.callout?.text];
  if (section.table) {
    parts.push(...(section.table.headers || []));
    for (const row of section.table.rows || []) parts.push(...row);
  }
  return parts.filter(Boolean).join(" ");
}

function scoreOverlap(wordBag, words) {
  let score = 0;
  for (const w of words) if (wordBag.has(w)) score++;
  return score;
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * `segments` is a flat list of `{text, start, end, videoIndex, videoTitle}`
 * (video-relative seconds - see pipeline.js's mergeSegments for the
 * multi-video case, which tags each video's segments with its own index/
 * title so a match can never straddle two different videos' timelines).
 * Mutates and returns `notes` - called once, right after the provider's
 * output passes schema validation (see notesGenerator.js), so there's
 * nothing else holding a reference to the pre-mutation object anyway.
 *
 * No match above the confidence threshold -> the section is left exactly
 * as the model produced it, no timestamp fields at all - graceful
 * degradation for content the transcript genuinely doesn't cover well
 * (a heavily paraphrased/summarized section) rather than guessing.
 */
export function attachTimestamps(notes, segments) {
  if (!segments || segments.length === 0) return notes;

  const usableSegments = segments
    .map((s) => ({ ...s, words: tokenize(s.text) }))
    .filter((s) => s.words.length > 0);
  if (usableSegments.length === 0) return notes;

  const videoIndexes = new Set(usableSegments.map((s) => s.videoIndex ?? 1));
  const isMultiVideo = videoIndexes.size > 1;

  for (const page of notes.pages || []) {
    for (const section of page.sections || []) {
      const wordBag = new Set(tokenize(sectionText(section)));
      if (wordBag.size === 0) continue;

      let best = null;
      for (const seg of usableSegments) {
        const score = scoreOverlap(wordBag, seg.words);
        if (score > 0 && (!best || score > best.score)) best = { seg, score };
      }
      if (!best || best.score < MIN_MATCH_SCORE) continue;

      const anchor = best.seg;
      const anchorVideoIndex = anchor.videoIndex ?? 1;
      const neighbors = usableSegments.filter(
        (s) =>
          (s.videoIndex ?? 1) === anchorVideoIndex &&
          Math.abs(s.start - anchor.start) <= RANGE_WINDOW_SECONDS &&
          scoreOverlap(wordBag, s.words) > 0
      );
      const rangeStart = Math.min(anchor.start, ...neighbors.map((s) => s.start));
      const rangeEnd = Math.max(anchor.end, ...neighbors.map((s) => s.end));

      section.timestampStart = formatTime(anchor.start);
      if (rangeEnd - rangeStart >= MIN_RANGE_SPAN_SECONDS) {
        section.timestampRange = `${formatTime(rangeStart)}–${formatTime(rangeEnd)}`;
      }
      if (isMultiVideo) {
        section.timestampVideo = anchor.videoTitle ? anchor.videoTitle : `Video ${anchorVideoIndex}`;
      }
    }
  }

  return notes;
}
