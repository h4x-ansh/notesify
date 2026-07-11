import { YoutubeTranscript } from "youtube-transcript";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * YouTube started rate-limiting/captcha-blocking Render's IP for both
 * caption fetches and yt-dlp (see the caption-fetch investigation in the
 * README) - authenticating as a logged-in browser session via cookies is
 * the standard workaround. YT_COOKIES_BASE64 holds a browser-exported
 * Netscape-format cookies.txt, base64-encoded so it can live safely in a
 * single-line env var (Render's dashboard, not a mounted file). Decoded
 * once here at module load - this file is imported exactly once per
 * process by both server.js and generate-notes.js, so "on import" is
 * "on startup" for either entry point - rather than re-decoding per
 * request. Left unset locally/in Electron on purpose, same pattern as
 * API_SHARED_SECRET in server.js: everything below degrades to today's
 * no-cookies behavior when it's absent.
 *
 * Timing/persistence, since both were worth double-checking rather than
 * assuming: `setupCookiesFile()` runs synchronously as a top-level const
 * initializer below, and Node fully evaluates a module (including all
 * top-level code) before any importer can call an exported function from
 * it - so the file write is structurally guaranteed to complete before
 * getTranscript() can ever be called, not just "usually early enough."
 * Render web services are one long-lived process, not a fresh container
 * per request, so this file is written once and reused for the process's
 * entire lifetime (every request until the next deploy/restart), not just
 * "for the duration of" any single request. Whether the target directory
 * is actually writable isn't assumed either - the write is immediately
 * read back below, so a silent failure (wrong permissions, read-only fs)
 * would surface as a thrown/caught error and a logged message, not a false
 * "success."
 */
const COOKIES_PATH = path.join(tmpdir(), "notesify-yt-cookies.txt");

function setupCookiesFile() {
  const b64 = process.env.YT_COOKIES_BASE64;
  // Length, never the value - this is a session credential.
  console.log(`[transcript] YT_COOKIES_BASE64 env var: ${b64 ? `present, length=${b64.length}` : "not set"}`);
  if (!b64) return null;

  console.log(`[transcript] writing cookies file to: ${COOKIES_PATH} (tmpdir=${tmpdir()})`);
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    writeFileSync(COOKIES_PATH, decoded, { mode: 0o600 });

    // Read back rather than trusting the write - confirms the file is
    // actually on disk at that path with real content, not just that
    // writeFileSync returned without throwing (e.g. silently truncated,
    // or the base64 decoded to something that isn't a cookie file at all).
    const writtenBack = readFileSync(COOKIES_PATH, "utf8");
    const firstLine = writtenBack.split("\n")[0];
    console.log(
      `[transcript] cookies file written: ${writtenBack.length} bytes, first line: ${JSON.stringify(firstLine)}`
    );

    return COOKIES_PATH;
  } catch (err) {
    console.error("[transcript] failed to decode/write YT_COOKIES_BASE64:", err.message);
    return null;
  }
}

/** Netscape cookie-jar format -> a `name=value; name2=value2` Cookie header, youtube.com entries only. */
function buildCookieHeader(cookiesPath) {
  if (!cookiesPath) return null;
  try {
    const content = readFileSync(cookiesPath, "utf8");
    const pairs = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const fields = trimmed.split("\t");
      if (fields.length < 7) continue;
      const [domain, , , , , name, value] = fields;
      if (!domain.includes("youtube.com")) continue;
      pairs.push(`${name}=${value}`);
    }
    return pairs.length > 0 ? pairs.join("; ") : null;
  } catch (err) {
    console.error("[transcript] failed to parse cookies file:", err.message);
    return null;
  }
}

const cookiesFilePath = setupCookiesFile();
const cookieHeader = buildCookieHeader(cookiesFilePath);
if (cookiesFilePath) {
  console.log(
    `[transcript] cookie header for youtube-transcript: ${cookieHeader ? `parsed OK, ${cookieHeader.split("; ").length} cookie(s)` : "parsed empty/failed - no youtube.com cookie lines found"}`
  );
}

/**
 * The youtube-transcript package has no `cookies` config option (checked
 * its TranscriptConfig type - just `lang` and `fetch`), but it does accept
 * a custom `fetch`, which is enough to attach a Cookie header the same way
 * --cookies does for yt-dlp below.
 */
function cookieAwareFetch(input, init = {}) {
  if (!cookieHeader) return fetch(input, init);
  const headers = new Headers(init.headers || {});
  headers.set("Cookie", cookieHeader);
  return fetch(input, { ...init, headers });
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]{11})/,
  ];
  for (const re of patterns) {
    const match = url.match(re);
    if (match) return match[1];
  }
  throw new Error(`Could not extract a video id from url: ${url}`);
}

/**
 * youtube-transcript's raw segments come back as `{text, offset, duration}`,
 * but the library's own XML parser (see node_modules/youtube-transcript's
 * parseTranscriptXml) is internally inconsistent about units depending on
 * which of YouTube's two caption formats it happened to parse: the newer
 * srv3 format gives offset/duration in milliseconds, the older classic
 * format gives them in fractional seconds - and neither is exposed to
 * callers, so there's no flag to just check. A typical single caption
 * segment spans a few seconds of speech at most; real per-segment
 * durations in *seconds* are almost always well under 20, while the same
 * durations in *milliseconds* are almost always in the thousands - using
 * the median duration across all segments (not just the first, in case of
 * one weird outlier) to tell the two apart is robust regardless of the
 * video's total length, which a raw-magnitude check on offset alone
 * wouldn't be (a long lecture's later offsets in seconds can plausibly
 * exceed a short video's early offsets in milliseconds).
 */
function normalizeSegments(rawSegments) {
  if (!rawSegments || rawSegments.length === 0) return [];
  const durations = rawSegments.map((s) => s.duration).filter((d) => typeof d === "number" && d > 0);
  const sorted = [...durations].sort((a, b) => a - b);
  const medianDuration = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const isMilliseconds = medianDuration > 50;
  const divisor = isMilliseconds ? 1000 : 1;

  return rawSegments
    .filter((s) => s.text && s.text.trim().length > 0)
    .map((s) => ({
      text: s.text,
      start: s.offset / divisor,
      end: (s.offset + s.duration) / divisor,
    }));
}

async function fetchCaptions(url) {
  const config = cookieHeader ? { fetch: cookieAwareFetch } : undefined;
  const rawSegments = await YoutubeTranscript.fetchTranscript(url, config);
  const text = rawSegments.map((s) => s.text).join(" ");
  const segments = normalizeSegments(rawSegments);
  return { text, segments };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error(`'${cmd}' not found on PATH. Install it to use the audio-transcription fallback.`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
  });
}

async function transcribeViaAudioFallback(url) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "No captions available for this video. Audio-transcription fallback requires OPENAI_API_KEY to be set."
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), "notesify-"));
  const audioPath = path.join(dir, "audio.mp3");

  try {
    const ytDlpArgs = [
      "-x",
      "--audio-format",
      "mp3",
      ...(cookiesFilePath ? ["--cookies", cookiesFilePath] : []),
      "-o",
      audioPath,
      url,
    ];
    console.log(`[transcript] running: yt-dlp ${ytDlpArgs.join(" ")}`);
    await run("yt-dlp", ytDlpArgs);

    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const fileBuffer = await readFile(audioPath);
    const transcription = await openai.audio.transcriptions.create({
      file: new File([fileBuffer], "audio.mp3", { type: "audio/mpeg" }),
      model: "whisper-1",
    });
    return transcription.text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Captions-only attempt, no yt-dlp/Whisper fallback - factored out of
 * getTranscript() so it can be reused as-is by Electron's main process
 * (see electron/main.js's "fetch-transcript" IPC handler), which needs the
 * exact same captions logic but must never trigger the audio fallback
 * itself (that stays part of the server's job pipeline - see the client-
 * side transcript-fetch work in the README). Returns null rather than
 * throwing on any failure - every caller here treats "couldn't get
 * captions" as a normal, expected outcome to fall back from, not an
 * exceptional one.
 *
 * `segments` (video-relative `{text, start, end}` in seconds - see
 * normalizeSegments above) rides along with a successful captions fetch,
 * for the timestamp-matching step in src/timestampMatcher.js (see
 * notesGenerator.js/pipeline.js). Deliberately absent whenever this
 * returns null or falls through to the Whisper fallback below - Whisper's
 * output is plain transcribed text with no per-segment timing, so a video
 * that needed it simply generates notes without timestamps rather than
 * fabricating fake ones.
 */
export async function fetchCaptionsOnly(url) {
  extractVideoId(url); // validate early, fail fast on a bad URL

  try {
    const { text, segments } = await fetchCaptions(url);
    if (text.trim().length > 0) return { text, source: "captions", segments };
    // Fetch "succeeded" but produced no usable text - a different failure
    // mode than the catch below (e.g. a caption track whose XML doesn't
    // match either format parseTranscriptXml understands), previously
    // indistinguishable from any other fallthrough since nothing logged it.
    console.error(`[transcript] captions fetch returned empty text for ${url}`);
  } catch (err) {
    // youtube-transcript throws typed errors (TooManyRequests/captcha,
    // VideoUnavailable, Disabled, NotAvailable, etc.) that used to be
    // discarded here with a bare `catch {}` - every failure looked
    // identical from the outside (a generic "no captions" message from the
    // fallback below), with zero signal on which of those it actually was,
    // even in this process's own logs. Logging the real error/type here is
    // the fix for that blind spot, not for the underlying caption-fetch
    // failures themselves - see the Render caption-fetch investigation in
    // the README for what prompted this.
    console.error(
      `[transcript] captions fetch failed for ${url}:`,
      err?.constructor?.name || "Error",
      "-",
      err?.message || String(err)
    );
  }

  return null;
}

/**
 * Resolves a transcript for a YouTube URL: captions first, then falls back
 * to yt-dlp audio extraction + Whisper if no captions exist. This is the
 * server-side path - used directly when a client didn't (or couldn't)
 * fetch captions itself first; see server.js's /generate accepting a
 * pre-fetched transcript to skip straight past this.
 */
export async function getTranscript(url) {
  const captionsResult = await fetchCaptionsOnly(url);
  if (captionsResult) return captionsResult;

  const text = await transcribeViaAudioFallback(url);
  return { text, source: "whisper" };
}
