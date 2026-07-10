import { YoutubeTranscript } from "youtube-transcript";

export interface ClientTranscriptResult {
  text: string;
  source: string;
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

export async function fetchTranscriptClientSide(youtubeUrl: string): Promise<ClientTranscriptResult | null> {
  if (typeof window !== "undefined" && window.notesifyBridge) {
    try {
      return await withTimeout(window.notesifyBridge.fetchTranscript(youtubeUrl), CLIENT_TRANSCRIPT_TIMEOUT_MS);
    } catch {
      return null;
    }
  }

  try {
    const segments = await withTimeout(YoutubeTranscript.fetchTranscript(youtubeUrl), CLIENT_TRANSCRIPT_TIMEOUT_MS);
    const text = segments.map((s) => s.text).join(" ");
    if (text.trim().length === 0) return null;
    return { text, source: "captions-client" };
  } catch {
    return null;
  }
}
