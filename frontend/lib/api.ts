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
  transcriptSource?: string;
  transcriptLength?: number;
  notesTitle?: string;
  pageCount?: number;
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
 * Render's free tier occasionally answers a perfectly healthy app with a
 * bare `404` carrying `x-render-routing: no-server` from its own edge
 * proxy, not from Express (confirmed empirically - see README, "Cold-start
 * / spin-down behavior actually observed"). Retrying that specific case a
 * couple of times clears it in practice. A real "job not found" 404 from
 * our own Express app is effectively never hit here since every jobId this
 * app requests comes from a prior successful /generate response - so it's
 * safe to retry on this signature without masking a genuine 404.
 */
async function fetchWithRetry(url: string, init: RequestInit, retries = 2, delayMs = 700): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 404 && res.headers.get("x-render-routing") === "no-server" && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return res;
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

/** Resolves true/false, never throws - used for the "is the server up yet" probe. */
export async function checkHealth(timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function generateNotes(youtubeUrl: string): Promise<{ jobId: string }> {
  let res: Response;
  try {
    res = await fetchWithRetry(`${API_BASE_URL}/generate`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ youtubeUrl }),
    });
  } catch {
    throw new ApiError("Can't reach the server. Is it running?");
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);
  return res.json();
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
 * Returns an object URL good for both the download link and the preview
 * iframe; callers are responsible for revoking it (URL.revokeObjectURL)
 * once it's no longer displayed.
 */
export async function fetchPdf(jobId: string): Promise<{ blobUrl: string; filename: string }> {
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
  return { blobUrl: URL.createObjectURL(blob), filename };
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
