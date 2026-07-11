/**
 * Classifies a raw pipeline error (which may contain a Gemini/Groq SDK
 * error message - internal URLs, quota metric names, model IDs - or a zod
 * validation dump with schema paths) into a small, stable set of codes plus
 * a generic, safe-to-display message. The raw error is never returned by
 * this function - callers are expected to log `err` themselves (full
 * message/stack) before/alongside calling this, so nothing is lost, it's
 * just no longer sent to an HTTP client. See server.js's /generate and
 * pipeline.js's error handling for where this is actually applied.
 */
export function classifyError(err) {
  const raw = err?.message || String(err);

  if (/\b429\b|quota|rate.?limit|resource.?exhausted|too many requests/i.test(raw)) {
    return {
      code: "rate_limited",
      message: "The note-generation service is rate-limited right now. Please try again in a few minutes.",
    };
  }
  if (/no captions available|transcript is disabled|no transcripts are available|video is no longer available/i.test(raw)) {
    return {
      code: "transcript_unavailable",
      message: "Couldn't get a transcript for this video - it may have no captions and no audio-transcription fallback is configured.",
    };
  }
  if (/schema validation|did not return valid json/i.test(raw)) {
    return {
      code: "invalid_output",
      message: "The generated notes didn't come back in the expected format. Please try again.",
    };
  }
  if (/could not extract a video id/i.test(raw)) {
    return {
      code: "invalid_url",
      message: "That doesn't look like a valid YouTube video URL.",
    };
  }
  return {
    code: "internal_error",
    message: "Something went wrong while generating your notes. Please try again later.",
  };
}
