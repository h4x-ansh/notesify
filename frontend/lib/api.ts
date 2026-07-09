// Thin client over the local Express API (server.js). This is a static
// export (see next.config.mjs) - there's no Next server at runtime to proxy
// through, so this talks directly to the backend's absolute URL, and
// server.js now has CORS enabled to allow it (see server.js). Baked in at
// build time since a static export can't read env vars at runtime; override
// with NEXT_PUBLIC_API_BASE_URL if the backend isn't on the default port.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4500";

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

/** Resolves true/false, never throws - used for the "is the local server up yet" probe. */
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
    res = await fetch(`${API_BASE_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtubeUrl }),
    });
  } catch {
    throw new ApiError("Can't reach the local server. Is it running?");
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);
  return res.json();
}

export async function getStatus(jobId: string): Promise<StatusResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/status/${jobId}`);
  } catch {
    throw new ApiError("Can't reach the local server. Is it running?");
  }
  if (!res.ok) throw new ApiError(await parseErrorBody(res), res.status);
  return res.json();
}

export function downloadUrl(jobId: string): string {
  return `${API_BASE_URL}/download/${jobId}`;
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
