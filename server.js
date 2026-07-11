#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./src/pipeline.js";
import { createJob, updateJob, getJob, listJobs } from "./src/jobStore.js";

/**
 * API wrapping the same pipeline the CLI uses. Runs two ways: spawned
 * locally by the Electron app (see electron/main.js) with no auth needed,
 * and deployed hosted on Render with a public URL for a future mobile app -
 * see requireApiSecret below for the shared-secret gate that only applies
 * to the latter.
 *
 * /generate kicks off runPipeline() without awaiting it (the pipeline takes
 * 30-60s+: transcript fetch, a Gemini call, then a Puppeteer render/print),
 * and immediately returns a jobId. The in-memory job store is what
 * /status and /download poll/read against.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so the packaged Electron app can point this at a writable
// location (e.g. app.getPath("userData")) instead of next to server.js,
// which may sit in a read-only install directory (Program Files).
const JOBS_DIR = process.env.JOBS_OUTPUT_DIR || path.join(__dirname, "output", "jobs");

const app = express();

// Render (and any other PaaS this ever runs behind) terminates TLS at a
// reverse proxy in front of the app - without this, every request looks
// like it comes from that proxy's own IP, which would make the per-IP rate
// limiting below either useless (one shared bucket for all real clients)
// or wrong. `1` trusts exactly one hop of X-Forwarded-For, matching
// Render's single-proxy setup. Harmless when there's no proxy at all (the
// Electron app's locally-spawned backend): with no X-Forwarded-For header
// present, express-rate-limit and req.ip both just fall back to the
// socket's own address.
app.set("trust proxy", 1);

// Default express.json() body limit is 100kb - too small for this app on
// purpose: real lecture transcripts sent client-side (see the client-side
// transcript-fetch work) can run well past that for long videos (a real
// one seen during testing was ~1.4MB of transcript text). 5mb comfortably
// covers that while still bounding worst-case request size; MAX_TRANSCRIPT_LENGTH
// below is the actual content-level cap enforced on /generate.
app.use(express.json({ limit: "5mb" }));

// The frontend is a static export served from its own local origin (a
// different port = a different origin as far as the browser is concerned),
// so it needs CORS to call this API. Both sides only ever run on localhost
// under Electron's control, so a permissive policy here doesn't expose
// anything beyond what's already true of any other localhost service.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Shared-secret auth, gated on API_SHARED_SECRET being set at all. Unset
// locally (CLI, dev, and the Electron app's locally-spawned backend - see
// electron/main.js) so none of those flows need to know about this; set on
// Render (see render.yaml) now that this same server.js is also deployed
// with a public URL. A missing vs. wrong secret both just get a 401 - no
// signal to a caller about which, since that itself is information.
const API_SHARED_SECRET = process.env.API_SHARED_SECRET;

function requireApiSecret(req, res, next) {
  if (!API_SHARED_SECRET) return next();
  if (req.header("X-API-Secret") !== API_SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * Per-IP rate limiting, tiered by how expensive each endpoint actually is.
 * There's no login/signup here - API_SHARED_SECRET is a single shared
 * credential, not per-user accounts - so this isn't brute-force login
 * protection, it's specifically about bounding how much of the shared
 * Gemini/Groq daily quota (see the multi-provider fallback work - free
 * tiers this project has already hit in normal use) one IP can burn
 * through /generate, the only endpoint that actually costs anything per
 * call. All thresholds are env-configurable rather than hardcoded, since
 * "correct" limits depend on real traffic this hasn't seen yet.
 */
function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

const generateLimiter = makeLimiter({
  windowMs: Number(process.env.RATE_LIMIT_GENERATE_WINDOW_MS) || 15 * 60 * 1000, // 15 min
  max: Number(process.env.RATE_LIMIT_GENERATE_MAX) || 5,
  message: "Too many generation requests from this IP. Please try again later.",
});

const statusLimiter = makeLimiter({
  windowMs: Number(process.env.RATE_LIMIT_STATUS_WINDOW_MS) || 60 * 1000, // 1 min
  max: Number(process.env.RATE_LIMIT_STATUS_MAX) || 60, // normal polling is ~30/min (every 2s) - headroom for retries
  message: "Too many status requests from this IP. Please slow down.",
});

const downloadLimiter = makeLimiter({
  windowMs: Number(process.env.RATE_LIMIT_DOWNLOAD_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_DOWNLOAD_MAX) || 20,
  message: "Too many download requests from this IP. Please try again later.",
});

/**
 * Lets the client safely retry POST /generate on a network-level failure
 * without risking a double-submitted job. The failure mode this exists for:
 * Render's edge proxy occasionally answers a healthy instance with a bare
 * 404 that carries no CORS headers at all (confirmed via raw curl - see
 * README's "Cold-start / spin-down behavior actually observed") - from a
 * browser, that's indistinguishable from any other network failure, since
 * the missing Access-Control-Allow-Origin means fetch() never even
 * delivers a readable Response to JS, just an opaque rejection. That
 * ambiguity is exactly why a blind client-side retry on *any* network
 * error was flagged as unsafe for this endpoint specifically (see
 * lib/api.ts's fetchWithRetry) - the request could have already reached
 * Express and created a job before the connection dropped.
 *
 * requestId (client-generated once per logical submit attempt, reused
 * across that attempt's retries - see generateNotes in lib/api.ts) makes
 * that ambiguity safe to retry through: a second POST with the same
 * requestId returns the job already created by the first, rather than
 * creating another one. Short TTL since this only needs to outlive a
 * handful of retries a few hundred ms apart, not actual request dedup at
 * any real timescale.
 */
const recentGenerateRequests = new Map(); // requestId -> { jobId, createdAt }
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function pruneIdempotencyCache() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [key, entry] of recentGenerateRequests) {
    if (entry.createdAt < cutoff) recentGenerateRequests.delete(key);
  }
}

// youtube.com/watch?v=, youtube.com/shorts/, or youtu.be/ followed by an
// 11-char video id - matches src/transcript.js's own extractVideoId()
// pattern, so anything this rejects would have failed inside the pipeline
// anyway; rejecting it here just does so before spending a job slot/quota
// on it. A generous but bounded length cap (real YouTube URLs are well
// under 200 chars) rather than trusting "starts with the right prefix" on
// an arbitrarily long string.
const YOUTUBE_URL_PATTERN = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{11}([?&]\S*)?$/i;
const MAX_YOUTUBE_URL_LENGTH = 500;
// Generous headroom over the longest real transcript seen during testing
// (~1.4M chars for a long lecture) without being unbounded - this is a
// content-level cap independent of express.json()'s raw byte limit above.
const MAX_TRANSCRIPT_LENGTH = 2_000_000;
const ALLOWED_TRANSCRIPT_SOURCES = ["captions", "captions-client", "client"];
const MAX_REQUEST_ID_LENGTH = 200;

app.post("/generate", requireApiSecret, generateLimiter, (req, res) => {
  const { youtubeUrl, transcript, transcriptSource, requestId } = req.body ?? {};

  if (
    !youtubeUrl ||
    typeof youtubeUrl !== "string" ||
    youtubeUrl.length > MAX_YOUTUBE_URL_LENGTH ||
    !YOUTUBE_URL_PATTERN.test(youtubeUrl)
  ) {
    return res.status(400).json({ error: "youtubeUrl must be a valid YouTube video URL" });
  }
  if (transcript !== undefined) {
    if (typeof transcript !== "string" || transcript.length === 0 || transcript.length > MAX_TRANSCRIPT_LENGTH) {
      return res
        .status(400)
        .json({ error: `transcript, if provided, must be a non-empty string under ${MAX_TRANSCRIPT_LENGTH} characters` });
    }
  }
  if (transcriptSource !== undefined && !ALLOWED_TRANSCRIPT_SOURCES.includes(transcriptSource)) {
    return res.status(400).json({ error: `transcriptSource, if provided, must be one of: ${ALLOWED_TRANSCRIPT_SOURCES.join(", ")}` });
  }
  if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH)) {
    return res.status(400).json({ error: "requestId, if provided, must be a non-empty string" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });
  }

  if (requestId) {
    pruneIdempotencyCache();
    const existing = recentGenerateRequests.get(requestId);
    if (existing) {
      return res.status(202).json({ jobId: existing.jobId });
    }
  }

  const job = createJob(youtubeUrl);
  if (requestId) recentGenerateRequests.set(requestId, { jobId: job.id, createdAt: Date.now() });
  const outputPath = path.join(JOBS_DIR, `${job.id}.pdf`);

  // A client (browser/WebView, or Electron's main process via IPC) can
  // fetch captions itself and send the text straight through, skipping
  // the server-side attempt entirely - done specifically to dodge Render's
  // blocked-IP problem for the mobile app (see the README's client-side
  // transcript-fetch section). If it's absent (client didn't try, or its
  // fetch failed), runPipeline falls through to the exact same server-side
  // captions-then-yt-dlp flow as before - unaffected either way.
  const preFetchedTranscript =
    transcript && transcript.trim().length > 0 ? { text: transcript, source: transcriptSource || "client" } : null;

  // Fire and forget: the route responds immediately with the jobId, the
  // pipeline keeps running in the background and reports progress via
  // updateJob(), which /status/:jobId reads.
  runPipeline(youtubeUrl, outputPath, {
    onUpdate: (patch) => updateJob(job.id, patch),
    preFetchedTranscript,
  }).catch((err) => {
    // runPipeline already records { stage: "error", error } via onUpdate
    // before rethrowing - this catch just stops the rejection from
    // surfacing as an unhandled promise rejection.
    console.error(`[job ${job.id}] failed:`, err.message);
  });

  res.status(202).json({ jobId: job.id });
});

app.get("/status/:jobId", requireApiSecret, statusLimiter, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });

  res.json({
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    errorCode: job.errorCode ?? null,
    ...job.meta,
  });
});

app.get("/download/:jobId", requireApiSecret, downloadLimiter, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.stage !== "done") {
    return res.status(409).json({ error: `job is not ready (stage: ${job.stage})` });
  }

  const filename = `${(job.meta.notesTitle || "notes").replace(/[^\w\- ]+/g, "").trim() || "notes"}.pdf`;
  res.download(job.outputPath, filename, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "failed to send file" });
    }
  });
});

// Per-jobId timing/state introspection, since this runs locally with no
// dashboard yet - console.log on the server process covers the rest.
// requireApiSecret was missing here until this security pass - these
// return full job objects (youtubeUrl, transcript length/source, notes
// title, timing data) with no auth at all once this is hosted with a
// public URL. Same gate as everything else now; still a no-op locally
// where API_SHARED_SECRET is unset.
app.get("/debug/jobs", requireApiSecret, (_req, res) => {
  res.json(listJobs());
});

app.get("/debug/jobs/:jobId", requireApiSecret, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Full error (message + stack) goes to the server's own log only -
  // err.message used to be sent straight to the client here, which for an
  // unexpected synchronous throw could be anything: a file path, a raw
  // driver/library error, whatever the failure happened to say. A generic
  // message is all an HTTP client ever needs; this is not the pipeline's
  // own error path (that's classifyError in src/errors.js, applied before
  // the job store is ever updated) - this only catches something Express
  // itself needs to handle, e.g. a malformed JSON body.
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4500;

// A plain `import.meta.url === file://${process.argv[1]}` string comparison
// breaks on Windows (backslashes, drive-letter casing), silently skipping
// app.listen() and exiting immediately. Comparing resolved filesystem paths
// instead works cross-platform.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`Notesify API listening on http://localhost:${PORT}`);
  });
}

export default app;
