import { YoutubeTranscript } from "youtube-transcript";

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

export interface ClientTranscriptResult {
  text: string;
  source: string;
  // Video-relative caption timing (seconds), when available - powers the
  // timestamp references on generated notes (see src/timestampMatcher.js
  // server-side). Absent whenever the source didn't produce per-segment
  // timing - notes just generate without timestamps for that video rather
  // than erroring (see NotesApp.tsx's prefetch loop / server.js's
  // validateSegments, both treat this as fully optional).
  segments?: TranscriptSegment[];
}

// Electron's renderer exposes this via electron/preload.cjs +
// contextBridge - see fetchTranscriptClientSide below for why Electron
// can't just call YoutubeTranscript.fetchTranscript() directly like the
// mobile build does.
declare global {
  interface Window {
    notesifyBridge?: {
      fetchTranscript: (youtubeUrl: string) => Promise<ClientTranscriptResult | null>;
    };
  }
}

/**
 * Fetches YouTube captions directly from the client rather than asking the
 * hosted backend to do it - the whole point being to use the client's own
 * IP instead of Render's, which YouTube has been blocking (see the
 * caption-fetch investigation in the README). Two very different
 * mechanisms depending on where this runs, both landing on the same
 * result shape:
 *
 * - **Electron**: `YoutubeTranscript.fetchTranscript()` calling `fetch()`
 *   directly from the renderer would hit the exact same browser CORS wall
 *   proven out during this work (YouTube's endpoints don't send
 *   `Access-Control-Allow-Origin` for a foreign origin - confirmed
 *   empirically, not assumed) - contextIsolation/nodeIntegration:false
 *   also block reaching Node's fetch directly. So this goes over IPC to
 *   the main process instead (see electron/main.js's "fetch-transcript"
 *   handler), which runs plain Node and was never subject to the browser's
 *   CORS enforcement in the first place - and never had the IP-blocking
 *   problem either, since it's the user's own local IP, not Render's.
 * - **Mobile (Capacitor/Android)**: no IPC bridge exists here - instead
 *   `capacitor.config.ts` enables `CapacitorHttp`, which patches
 *   `window.fetch` on native platforms to route through native OS
 *   networking rather than the WebView's engine, sidestepping the same
 *   CORS wall a different way (the request never goes through anything
 *   that enforces same-origin policy). `YoutubeTranscript.fetchTranscript()`
 *   is called directly here and doesn't need to know this is happening -
 *   from its point of view `fetch` just works.
 * - **Plain browser (e.g. `next dev`)**: neither mechanism applies, so this
 *   will fail with a real CORS error and return null - expected and fine,
 *   this path was never meant to run outside Electron/Capacitor; the
 *   server-side fallback (see lib/api.ts's generateNotes) covers it.
 *
 * Returns null on any failure rather than throwing - every caller treats
 * "couldn't fetch client-side" as an expected, recoverable case: fall back
 * to letting the server try (its own captions attempt, then yt-dlp/Whisper
 * - unchanged, still fully server-side).
 *
 * Bounded by a timeout - a stalled connection (more plausible on mobile
 * data than a desktop's usual wired/wifi path) would otherwise hang
 * whichever branch is awaiting it indefinitely rather than falling back,
 * which is the one way this could still "silently break" despite the
 * try/catches above.
 */
const CLIENT_TRANSCRIPT_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("client-side transcript fetch timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * youtube-transcript's raw `{text, offset, duration}` segments are
 * internally inconsistent about units depending on which of YouTube's two
 * caption XML formats the library happened to parse - srv3 gives
 * milliseconds, the older classic format gives fractional seconds - with
 * no flag exposed to tell them apart. Mirrors the same median-duration
 * heuristic src/transcript.js's normalizeSegments uses server-side (real
 * per-segment speech durations in seconds are almost always under 20;
 * in milliseconds they're almost always in the thousands) - duplicated
 * here rather than shared, since this is a separate frontend package with
 * its own youtube-transcript install, not a code path that can import
 * from src/ across the Electron/Next.js boundary.
 */
function normalizeSegments(rawSegments: { text: string; offset: number; duration: number }[]): TranscriptSegment[] {
  if (rawSegments.length === 0) return [];
  const durations = rawSegments.map((s) => s.duration).filter((d) => typeof d === "number" && d > 0);
  const sorted = [...durations].sort((a, b) => a - b);
  const medianDuration = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const divisor = medianDuration > 50 ? 1000 : 1;

  return rawSegments
    .filter((s) => s.text && s.text.trim().length > 0)
    .map((s) => ({ text: s.text, start: s.offset / divisor, end: (s.offset + s.duration) / divisor }));
}

export async function fetchTranscriptClientSide(youtubeUrl: string): Promise<ClientTranscriptResult | null> {
  if (typeof window !== "undefined" && window.notesifyBridge) {
    try {
      return await withTimeout(window.notesifyBridge.fetchTranscript(youtubeUrl), CLIENT_TRANSCRIPT_TIMEOUT_MS);
    } catch {
      return null;
    }
  }

  try {
    const rawSegments = await withTimeout(YoutubeTranscript.fetchTranscript(youtubeUrl), CLIENT_TRANSCRIPT_TIMEOUT_MS);
    const text = rawSegments.map((s) => s.text).join(" ");
    if (text.trim().length === 0) return null;
    return { text, source: "captions-client", segments: normalizeSegments(rawSegments) };
  } catch {
    return null;
  }
}
