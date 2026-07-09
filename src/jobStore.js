import { randomUUID } from "node:crypto";

/**
 * In-memory job store. This is a local-only server (runs inside Electron
 * later), so a Map is enough - no database, no persistence across restarts.
 */
const jobs = new Map();

export function createJob(youtubeUrl) {
  const job = {
    id: randomUUID(),
    youtubeUrl,
    stage: "queued",
    progress: 0,
    error: null,
    outputPath: null,
    timings: null,
    meta: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return undefined;
  const { meta, ...rest } = patch;
  Object.assign(job, rest);
  if (meta) Object.assign(job.meta, meta);
  job.updatedAt = Date.now();
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function listJobs() {
  return Array.from(jobs.values());
}
