#!/usr/bin/env node
import "dotenv/config";
import express from "express";
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
app.use(express.json());

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

app.post("/generate", requireApiSecret, (req, res) => {
  const { youtubeUrl, transcript, transcriptSource } = req.body ?? {};
  if (!youtubeUrl || typeof youtubeUrl !== "string") {
    return res.status(400).json({ error: "youtubeUrl (string) is required" });
  }
  if (transcript !== undefined && typeof transcript !== "string") {
    return res.status(400).json({ error: "transcript, if provided, must be a string" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });
  }

  const job = createJob(youtubeUrl);
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

app.get("/status/:jobId", requireApiSecret, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });

  res.json({
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    ...job.meta,
  });
});

app.get("/download/:jobId", requireApiSecret, (req, res) => {
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
app.get("/debug/jobs", (_req, res) => {
  res.json(listJobs());
});

app.get("/debug/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "internal server error" });
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
