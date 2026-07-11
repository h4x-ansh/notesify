import { spawn } from "node:child_process";
import { PipelineError } from "./errors.js";

/**
 * Playlist resolution and per-video title lookup for the "multiple videos"
 * flow (see src/pipeline.js's batch path and server.js's /generate).
 * yt-dlp is already a dependency here (the audio-transcription fallback in
 * src/transcript.js), so reusing it for `--flat-playlist` listing and
 * `--print title` metadata is a lookup, not a new integration - no video is
 * actually downloaded for either operation (`--flat-playlist` skips per-
 * video extraction entirely; the title lookup below passes `--skip-download`).
 */

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error(`'${cmd}' not found on PATH.`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
  });
}

/**
 * Resolves a playlist URL to an ordered list of individual video watch
 * URLs. `--flat-playlist` lists the playlist's contents without visiting
 * each video page, so this is fast regardless of playlist length -
 * `maxVideos` is enforced *after* listing (we don't know the real count
 * until yt-dlp reports it) with a clear rejection rather than silently
 * processing only the first N - a caller asking for a 40-video playlist
 * should find out it's over the limit, not quietly get 20 videos of notes
 * and wonder where the rest went.
 */
export async function resolvePlaylistVideoUrls(playlistUrl, { maxVideos } = {}) {
  const output = await runCapture("yt-dlp", ["--flat-playlist", "--print", "id", playlistUrl]);
  const ids = output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new PipelineError("Couldn't resolve any videos from this playlist - check the link and try again.", "invalid_playlist");
  }
  if (maxVideos && ids.length > maxVideos) {
    throw new PipelineError(
      `This playlist has ${ids.length} videos, over the ${maxVideos}-video limit for a single batch. Try a shorter playlist, or add individual videos instead.`,
      "playlist_too_large"
    );
  }

  return ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
}

/**
 * Best-effort title lookup for a single video - used to label each video's
 * section in the merged transcript (see pipeline.js's mergeTranscripts) and
 * to identify a skipped video in job metadata. Never throws: a missing/
 * broken yt-dlp shouldn't take down the whole batch over what's ultimately
 * cosmetic labeling - falls back to the URL itself, which is still a
 * meaningful (if less friendly) label.
 */
export async function fetchVideoTitle(videoUrl) {
  try {
    const output = await runCapture("yt-dlp", ["--skip-download", "--print", "%(title)s", videoUrl]);
    const title = output.split("\n")[0]?.trim();
    return title || videoUrl;
  } catch (err) {
    console.error(`[playlist] title lookup failed for ${videoUrl}:`, err.message);
    return videoUrl;
  }
}
