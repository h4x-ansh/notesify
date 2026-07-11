// Thin client over the Express API (server.js). This is a static export
// (see next.config.mjs) - there's no Next server at runtime to proxy
// through, so this talks directly to the backend's absolute URL. Two build
// targets share this file: Electron (API_BASE_URL defaults to the locally-
// spawned backend, no secret needed) and the Capacitor/Android build (built
// with NEXT_PUBLIC_API_BASE_URL pointed at the hosted Render instance and
// NEXT_PUBLIC_API_SHARED_SECRET set - see frontend/README.md). Both are
// baked in at `next build` time since a static export can't read env vars
// at runtime.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4500";

// Only set for the hosted/mobile build - server.js only enforces this
// header when API_SHARED_SECRET is configured on its end (unset for
// Electron's locally-spawned backend, see server.js's requireApiSecret).
const API_SHARED_SECRET = process.env.NEXT_PUBLIC_API_SHARED_SECRET;

// Drives copy that assumes a Render-style free-tier host (cold starts,
// occasional edge-routing hiccups) rather than a backend Electron just
// spawned itself, which is instant by comparison.
export const IS_HOSTED_BACKEND = !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(API_BASE_URL);

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return API_SHARED_SECRET ? { ...extra, "X-API-Secret": API_SHARED_SECRET } : extra;
}

export type Stage =
  | "queued"
  | "extracting_transcript"
  | "generating_notes"
  | "rendering_pdf"
  | "done"
  | "error";

export interface StatusResponse {
  stage: Stage;
  progress: number;
  error: string | null;
  // Stable machine-readable classification of `error` (e.g. "rate_limited")
  // - added alongside a server-side security pass that stopped forwarding
  // raw Gemini/Groq error text to the client (see src/errors.js). Not yet
  // consumed here; isRateLimitError's message-regex approach still works
  // since the sanitized message still contains words like "rate-limited",
  // but this is the more robust signal to switch to.
  errorCode?: string | null;
  transcriptSource?: string;
  transcriptLength?: number;
  notesTitle?: string;
  pageCount?: number;
  // Quality tier picker (see src/notesGenerator.js's buildProvidersForTier)
  // - which provider actually produced the notes, and whether it wasn't
  // the tier's first-choice provider (only possible for "Normal", the only
  // tier with more than one step - see the "done" view, which shows this
  // only when providerCascaded is true rather than always).
  notesProvider?: string;
  providerCascaded?: boolean;
  // "Multiple videos" flow only (see src/pipeline.js's batch path) - a
  // human-readable per-video status ("Fetching video 2 of 4...") during
  // extracting_transcript, and any videos that failed and were skipped
  // rather than failing the whole batch, each with why.
  batchProgress?: string;
  skippedVideos?: { url: string; title: string; reason: string }[];
  // Auto-chunked playlist flow only (see server.js's /generate) - links a
  // chunk's job back to the sibling jobs it was split from, and where in
  // the original playlist this chunk's videos fall (e.g. "21-40").
  batchGroupId?: string;
  chunkIndex?: number;
  chunkCount?: number;
  chunkRange?: string;
}

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // response wasn't JSON - fall through to a generic message
  }
  return `Request failed (${res.status})`;
}

/**
 * Render's free tier occasionally answers a healthy app with a no-server
 * edge-proxy failure instead of actually routing to it (see README,
 * "Cold-start / spin-down behavior actually observed"). This used to try
 * detecting that *specific* case - a `404` with an `x-render-routing:
 * no-server` response header - and only retry that. Turned out to be dead
 * code: that response carries no `Access-Control-Allow-Origin` header at
 * all, so a cross-origin `fetch()` never delivers a readable `Response`
 * for it in the first place - it just throws an opaque network error,
 * indistinguishable from a connection reset or a DNS failure. Confirmed by
 * reproducing the exact response shape through a real browser (Puppeteer),
 * not assumed - the specific-detection branch simply could never execute
 * in production.
 *
 * So this just retries on any thrown fetch error now - which is exactly
 * what was actually catching the no-server case all along, via the
 * generic path rather than the specific one that never fired. That's only
 * safe to do broadly because every caller here is either read-only
 * (GET /status, /download, /health - retrying can never cause harm) or
 * made idempotent another way: POST /generate sends a stable `requestId`
 * (see generateNotes below and the matching cache in server.js) so a
 * retried request returns the job already created instead of creating a
 * second one, rather than relying on being able to prove "nothing happened
 * yet" from the response shape - which, per the above, isn't something a
 * browser can actually observe here anyway.
 */
async function fetchWithRetry(url: string, init: RequestInit, retries = 2, delayMs = 700): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }
  throw lastErr;
}

/**
 * Resolves true/false, never throws - used for the "is the server up yet"
 * probe. Deliberately does NOT use fetchWithRetry - NotesApp.tsx's
 * `checking-server`/`server-unreachable` views already call this in their
 * own external polling loop (every HEALTH_RETRY_MS, indefinitely until it
 * succeeds), which is already a retry mechanism. Stacking fetchWithRetry's
 * internal retries on top would just make each individual poll take longer
 * (up to ~1.4s of internal backoff before reporting "still down") without
 * changing the eventual up/down outcome - the UI would look less
 * responsive to a genuine recovery for no real benefit.
 */
export async function checkHealth(timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * `clientTranscript`, when present, was already fetched client-side (see
 * lib/transcript.ts) - the server skips its own captions/yt-dlp attempt
 * entirely and goes straight to notes generation. Omit it (or pass null,
 * e.g. the client-side fetch failed) to get the old behavior: the server
 * tries on its own, still falling back to yt-dlp/Whisper as before.
 *
 * A network-level failure here is genuinely ambiguous - the request could
 * have already reached Express and created a job before the connection
 * dropped, so a blind retry risks double-submitting. That risk turned out
 * to matter more than it first looked: Render's no-server edge-proxy 404
 * (the specific case fetchWithRetry's no-server branch was written to
 * handle) ships with no CORS headers of its own at all, so from inside a
 * real browser it never actually reaches that branch - fetch() throws an
 * opaque network error before JS can inspect status/headers, landing in
 * the *generic* network-error path instead (confirmed by testing the
 * literal no-server response shape through Puppeteer, not assumed).
 * Meaning: without something to make retry provably safe, the most common
 * real failure this is meant to recover from would still have to be
 * treated as unsafe-to-retry.
 *
 * `requestId` is that something - generated once per logical submit
 * attempt and reused unchanged across every retry of that attempt (it's
 * computed here, before fetchWithRetry's loop, not inside it), it lets
 * server.js's idempotency cache return the original job on a retry instead
 * of creating a second one. See the matching comment in server.js.
 */
/** English is the omitted/default case - see notesGenerator.js, it's a no-op there too. */
export const SUPPORTED_LANGUAGES = ["English", "Hindi", "Tamil", "Bengali"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export interface StylePreset {
  id: string;
  label: string;
}

// Keep in sync with src/template.js's STYLE_PRESETS keys/labels - small,
// stable list (3 items), not worth cross-language shared-config infra for.
// `classic` first/default matches template.js's own DEFAULT_STYLE_ID.
export const STYLE_PRESETS: StylePreset[] = [
  { id: "classic", label: "Classic Topper" },
  { id: "coolTones", label: "Cool Tones" },
  { id: "minimal", label: "Minimal" },
];

// Keep in sync with src/notesGenerator.js's buildProvidersForTier - High
// maps to gemini-2.5-flash only (no cascade), Normal (default) starts at
// Groq and cascades to Flash-Lite, Low is Flash-Lite only. "Normal" is the
// omitted/default case, same pattern as English/classic above.
export const SUPPORTED_QUALITY_TIERS = ["High", "Normal", "Low"] as const;
export type QualityTier = (typeof SUPPORTED_QUALITY_TIERS)[number];

/** All optional - omitted entirely (not even sent as empty strings) falls back to English/classic/Normal server-side, see server.js and template.js/notesGenerator.js. */
export interface LanguageStyleOptions {
  language?: string;
  styleId?: string;
  qualityTier?: string;
}

function languageStyleFields({ language, styleId, qualityTier }: LanguageStyleOptions = {}) {
  return {
    ...(language && language !== "English" ? { language } : {}),
    ...(styleId && styleId !== "classic" ? { styleId } : {}),
    ...(qualityTier && qualityTier !== "Normal" ? { qualityTier } : {}),
  };
}

/**
 * `clientTranscript`, when present, was already fetched client-side (see
 * lib/transcript.ts) - the server skips its own captions/yt-dlp attempt
 * entirely and goes straight to notes generation. Omit it (or pass null,
 * e.g. the client-side fetch failed) to get the old behavior: the server
 * tries on its own, still falling back to yt-dlp/Whisper as before.
 *
 * A network-level failure here is genuinely ambiguous - the request could
 * have already reached Express and created a job before the connection
 * dropped, so a blind retry risks double-submitting. That risk turned out
 * to matter more than it first looked: Render's no-server edge-proxy 404
 * (the specific case fetchWithRetry's no-server branch was written to
 * handle) ships with no CORS headers of its own at all, so from inside a
 * real browser it never actually reaches that branch - fetch() throws an
 * opaque network error before JS can inspect status/headers, landing in
 * the *generic* network-error path instead (confirmed by testing the
 * literal no-server response shape through Puppeteer, not assumed).
 * Meaning: without something to make retry provably safe, the most common
 * real failure this is meant to recover from would still have to be
 * treated as unsafe-to-retry.
 *
 * `requestId` is that something - generated once per logical submit
 * attempt and reused unchanged across every retry of that attempt (it's
 * computed here, before fetchWithRetry's loop, not inside it), it lets
 * server.js's idempotency cache return the original job on a retry instead
 * of creating a second one. See the matching comment in server.js.
 */
export async function generateNotes(
  youtubeUrl: string,
  clientTranscript?: { text: string; source: string; segments?: { text: string; start: number; end: number }[] } | null,
  options?: LanguageStyleOptions
): Promise<{ jobId: string }> {
  const requestId = crypto.randomUUID();
  let res: Response;
  try {
    res = await fetchWithRetry(`${API_BASE_URL}/generate`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        youtubeUrl,
        requestId,
        ...(clientTranscript
          ? {
              transcript: clientTranscript.text,
              transcriptSource: clientTranscript.source,
              // Video-relative caption timing, when the client-side fetch
              // produced it - see lib/transcript.ts's fetchTranscriptClientSide
              // and server.js's validateSegments. Powers the timestamp
              // references on generated notes (src/timestampMatcher.js);
              // simply omitted when unavailable, no different from before
              // this field existed.
              ...(clientTranscript.segments?.length ? { segments: clientTranscript.segments } : {}),
            }
          : {}),
        ...languageStyleFields(options),
      }),
    });
  } catch {
    throw new ApiError("Can't reach the server. Is it running?");
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);
  return res.json();
}

/**
 * The "multiple videos" flow's request shape (see components/MultiLinkInput.tsx) -
 * either a batch of individually-pasted video links, or a single playlist
 * link standing in for its entire contents. Mutually exclusive with
 * `youtubeUrl`/generateNotes above, and with each other - the UI only ever
 * builds one or the other, never both. Runs through the same real
 * resolve/fetch/merge pipeline as a single video, just with N transcripts
 * instead of one - see src/pipeline.js.
 */
export type BatchPayload = { videoUrls: string[] } | { playlistUrl: string };

/**
 * What a playlist would auto-split into (see server.js's chunkPlaylistVideos)
 * - only relevant when a playlist has more videos than fit in one chunk.
 * Each chunk becomes its own independent pipeline run/PDF, so this is shown
 * to the user as a quota-consumption warning ("N separate PDFs, N of your
 * daily generations") requiring explicit confirmation before any of those
 * N Gemini calls actually fire - see generateNotesBatch's confirmChunking
 * option below.
 */
export interface PlaylistPlan {
  totalVideos: number;
  chunkSize: number;
  chunkCount: number;
  chunks: { index: number; start: number; end: number; count: number }[];
}

/** Same per-chunk shape as PlaylistPlan, but with each chunk's actual video
 * URLs included - what /playlist/resolve returns (see resolvePlaylist below),
 * needed by the client-side transcript prefetch loop (NotesApp.tsx's
 * handleGenerate) to know which videos to fetch captions for before ever
 * calling /generate. PlaylistPlan itself only carries counts/ranges (what
 * the confirm-chunks screen displays) since /generate's own 409
 * needsConfirmation response deliberately doesn't leak the full URL list. */
export interface PlaylistResolution {
  totalVideos: number;
  chunkSize: number;
  chunkCount: number;
  chunks: { index: number; start: number; end: number; urls: string[] }[];
}

/**
 * Resolves a playlist to its real per-video URLs, chunked the same way
 * /generate's own auto-chunking would - called before every playlist
 * submission now (not just ones that end up needing multiple chunks), since
 * the client needs the actual video URLs to fetch each one's transcript
 * client-side (see fetchTranscriptClientSide in lib/transcript.ts) before
 * ever hitting /generate. This is the same Render-IP-blocking problem the
 * single-video path already solved, just applied per-video here too.
 */
export async function resolvePlaylist(playlistUrl: string): Promise<PlaylistResolution> {
  let res: Response;
  try {
    res = await fetchWithRetry(`${API_BASE_URL}/playlist/resolve`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ playlistUrl }),
    });
  } catch {
    throw new ApiError("Can't reach the server. Is it running?");
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);
  return res.json();
}

export type GenerateBatchResult =
  | { kind: "job"; jobId: string }
  | { kind: "batch"; batchGroupId: string; jobIds: string[] }
  | { kind: "needsConfirmation"; plan: PlaylistPlan };

/**
 * `confirmChunking` should only ever be sent as `true` after the user has
 * seen and accepted the PlaylistPlan from a first call's `needsConfirmation`
 * result - see NotesApp.tsx's confirm-chunks view. A first call without it
 * either succeeds outright (playlist fits in one chunk, or a plain
 * videoUrls[] batch - both return `{kind:"job"}` exactly as before this
 * feature existed) or comes back as `{kind:"needsConfirmation"}` for a
 * caller to act on, never silently firing multiple Gemini calls on its own.
 */
export async function generateNotesBatch(
  payload: BatchPayload,
  options?: LanguageStyleOptions & {
    confirmChunking?: boolean;
    // Per-video transcripts already fetched client-side (see
    // NotesApp.tsx's prefetch loop, added to close the same Render-IP-
    // blocking gap the single-video path's `clientTranscript` already
    // solves) - keyed by the exact video URL fetched. A video missing from
    // this map falls through to the server's own captions-then-yt-dlp/
    // Whisper attempt, same as if this option were omitted entirely.
    // `segments`, when present per video, powers that video's timestamp
    // references (src/timestampMatcher.js server-side) - optional, same
    // graceful-degradation rule as the single-video path.
    transcripts?: Record<string, { text: string; source: string; segments?: { text: string; start: number; end: number }[] }>;
  }
): Promise<GenerateBatchResult> {
  const requestId = crypto.randomUUID();
  const { confirmChunking, transcripts, ...styleOptions } = options ?? {};
  let res: Response;
  try {
    res = await fetchWithRetry(`${API_BASE_URL}/generate`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        ...payload,
        requestId,
        ...languageStyleFields(styleOptions),
        ...(confirmChunking ? { confirmChunking: true } : {}),
        ...(transcripts && Object.keys(transcripts).length > 0 ? { transcripts } : {}),
      }),
    });
  } catch {
    throw new ApiError("Can't reach the server. Is it running?");
  }

  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body?.needsConfirmation) {
      return {
        kind: "needsConfirmation",
        plan: { totalVideos: body.totalVideos, chunkSize: body.chunkSize, chunkCount: body.chunkCount, chunks: body.chunks },
      };
    }
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);

  const body = await res.json();
  if (body.batchGroupId) return { kind: "batch", batchGroupId: body.batchGroupId, jobIds: body.jobIds };
  return { kind: "job", jobId: body.jobId };
}

export async function getStatus(jobId: string): Promise<StatusResponse> {
  let res: Response;
  try {
    res = await fetchWithRetry(`${API_BASE_URL}/status/${jobId}`, { headers: authHeaders() });
  } catch {
    throw new ApiError("Can't reach the server. Is it running?");
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);
  return res.json();
}

/**
 * Downloads happen through an authenticated fetch rather than a plain
 * `<a href>`/`<iframe src>` because those can't carry the X-API-Secret
 * header the hosted backend requires - a static link would just 401.
 * Returns the raw Blob rather than an object URL - what a caller does with
 * it differs by platform (Electron/desktop: URL.createObjectURL() for a
 * normal download link/preview; mobile: write it to disk and hand it to
 * the native Share sheet, since blob: URLs don't produce any visible
 * save/open behavior in Android's WebView - see lib/downloadPdf.ts).
 */
export async function fetchPdf(jobId: string): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetchWithRetry(`${API_BASE_URL}/download/${jobId}`, { headers: authHeaders() });
  } catch {
    throw new ApiError("Can't reach the server to download the PDF.");
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);

  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const filename = match ? match[1] : "notes.pdf";

  const blob = await res.blob();
  return { blob, filename };
}

/** Loose client-side sanity check - the server is the real source of truth. */
export function looksLikeYoutubeUrl(value: string): boolean {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{6,}/i;
  return pattern.test(value.trim());
}

/**
 * Best-effort detection of Gemini rate-limit/quota failures from the error
 * message string surfaced by /status. No backend contract for this - just
 * pattern matching on the text Gemini's SDK/API typically produces for a 429.
 */
export function isRateLimitError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\b429\b|rate.?limit|quota|resource.?exhausted|too many requests/i.test(message);
}
