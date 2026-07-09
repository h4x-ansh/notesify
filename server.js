#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./src/pipeline.js";
import { createJob, updateJob, getJob, listJobs } from "./src/jobStore.js";

/**
 * Local-only API wrapping the same pipeline the CLI uses. This is meant to
 * run alongside a future UI (initially inside Electron) - not internet-
 * facing, so no auth/rate-limiting here on purpose.
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
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.post("/generate", (req, res) => {
  const { youtubeUrl } = req.body ?? {};
  if (!youtubeUrl || typeof youtubeUrl !== "string") {
    return res.status(400).json({ error: "youtubeUrl (string) is required" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });
  }

  const job = createJob(youtubeUrl);
  const outputPath = path.join(JOBS_DIR, `${job.id}.pdf`);

  // Fire and forget: the route responds immediately with the jobId, the
  // pipeline keeps running in the background and reports progress via
  // updateJob(), which /status/:jobId reads.
  runPipeline(youtubeUrl, outputPath, {
    onUpdate: (patch) => updateJob(job.id, patch),
  }).catch((err) => {
    // runPipeline already records { stage: "error", error } via onUpdate
    // before rethrowing - this catch just stops the rejection from
    // surfacing as an unhandled promise rejection.
    console.error(`[job ${job.id}] failed:`, err.message);
  });

  res.status(202).json({ jobId: job.id });
});

app.get("/status/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });

  res.json({
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    ...job.meta,
  });
});

app.get("/download/:jobId", (req, res) => {
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
