import { YoutubeTranscript } from "youtube-transcript";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

async function fetchCaptions(url) {
  const segments = await YoutubeTranscript.fetchTranscript(url);
  return segments.map((s) => s.text).join(" ");
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
    await run("yt-dlp", [
      "-x",
      "--audio-format",
      "mp3",
      "-o",
      audioPath,
      url,
    ]);

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
 * Resolves a transcript for a YouTube URL: captions first, then falls back
 * to yt-dlp audio extraction + Whisper if no captions exist.
 */
export async function getTranscript(url) {
  extractVideoId(url); // validate early, fail fast on a bad URL

  try {
    const text = await fetchCaptions(url);
    if (text.trim().length > 0) return { text, source: "captions" };
  } catch {
    // fall through to audio transcription
  }

  const text = await transcribeViaAudioFallback(url);
  return { text, source: "whisper" };
}
