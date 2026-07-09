"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./NotesApp.module.css";
import {
  ApiError,
  checkHealth,
  downloadUrl,
  generateNotes,
  getStatus,
  isRateLimitError,
  looksLikeYoutubeUrl,
  type Stage,
  type StatusResponse,
} from "@/lib/api";

const STAGE_LABELS: Record<Stage, string> = {
  queued: "Queued...",
  extracting_transcript: "Pulling the lecture transcript...",
  generating_notes: "Generating structured notes...",
  rendering_pdf: "Rendering your handwritten notes...",
  done: "Done!",
  error: "Something went wrong",
};

const POLL_INTERVAL_MS = 2000;
const HEALTH_RETRY_MS = 2000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

type View =
  | { kind: "checking-server" }
  | { kind: "server-unreachable" }
  | { kind: "input" }
  | { kind: "progress"; jobId: string; status: StatusResponse; reconnecting: boolean }
  | { kind: "done"; jobId: string; status: StatusResponse }
  | { kind: "error"; message: string; rateLimited: boolean; cooldownUntil: number | null };

/** Gemini rate limits are per-minute, so a 45-60s window comfortably clears one. */
function rateLimitCooldownMs(): number {
  return (45 + Math.floor(Math.random() * 16)) * 1000; // 45-60s
}

export default function NotesApp() {
  const [view, setView] = useState<View>({ kind: "checking-server" });
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const pollFailuresRef = useRef(0);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);

  // Initial "is the local server up" probe, then keep retrying until it is.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function probe() {
      const healthy = await checkHealth();
      if (cancelled) return;
      if (healthy) {
        setView((v) => (v.kind === "checking-server" || v.kind === "server-unreachable" ? { kind: "input" } : v));
      } else {
        setView({ kind: "server-unreachable" });
        retryTimer = setTimeout(probe, HEALTH_RETRY_MS);
      }
    }

    probe();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  // Poll job status while a generation is in progress.
  useEffect(() => {
    if (view.kind !== "progress") return;
    const jobId = view.jobId;
    let cancelled = false;

    const interval = setInterval(async () => {
      try {
        const status = await getStatus(jobId);
        if (cancelled) return;
        pollFailuresRef.current = 0;

        if (status.stage === "error") {
          const message = status.error || "The generation job failed.";
          const rateLimited = isRateLimitError(message);
          setView({
            kind: "error",
            message,
            rateLimited,
            cooldownUntil: rateLimited ? Date.now() + rateLimitCooldownMs() : null,
          });
          return;
        }
        if (status.stage === "done") {
          setView({ kind: "done", jobId, status });
          return;
        }
        setView({ kind: "progress", jobId, status, reconnecting: false });
      } catch {
        if (cancelled) return;
        pollFailuresRef.current += 1;
        if (pollFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          setView({ kind: "server-unreachable" });
        } else {
          setView((v) => (v.kind === "progress" ? { ...v, reconnecting: true } : v));
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [view.kind === "progress" ? view.jobId : null]);

  // Tick down the rate-limit cooldown once a second while an error view is
  // showing one, so the "Try again" button re-enables on its own without
  // requiring another click/poll.
  useEffect(() => {
    if (view.kind !== "error" || !view.cooldownUntil) {
      setCooldownRemainingMs(0);
      return;
    }
    const cooldownUntil = view.cooldownUntil;
    const tick = () => setCooldownRemainingMs(Math.max(0, cooldownUntil - Date.now()));
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [view.kind === "error" ? view.cooldownUntil : null]);

  function resetToInput() {
    if (cooldownRemainingMs > 0) return;
    pollFailuresRef.current = 0;
    setSubmitError(null);
    setView({ kind: "input" });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!looksLikeYoutubeUrl(url)) {
      setUrlError("That doesn't look like a YouTube URL.");
      return;
    }
    setUrlError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const { jobId } = await generateNotes(url.trim());
      pollFailuresRef.current = 0;
      setView({ kind: "progress", jobId, status: { stage: "queued", progress: 0, error: null }, reconnecting: false });
    } catch (err) {
      if (err instanceof ApiError && !err.status) {
        // No status code = the fetch itself failed, i.e. the server dropped.
        setView({ kind: "server-unreachable" });
      } else {
        const message = err instanceof Error ? err.message : "Failed to start generation.";
        if (isRateLimitError(message)) {
          // Rate limit hit before a job even started - route through the same
          // error+cooldown view rather than the inline input-screen error.
          setView({ kind: "error", message, rateLimited: true, cooldownUntil: Date.now() + rateLimitCooldownMs() });
        } else {
          setSubmitError(message);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>
          hisarchives / <strong>notesify</strong>
        </span>
      </div>

      <div className={styles.card}>
        {view.kind === "checking-server" && (
          <div className={styles.unreachableWrap}>
            <span className={styles.pulseDot} />
            <p className={styles.subtitle} style={{ margin: 0 }}>
              Connecting to local server...
            </p>
          </div>
        )}

        {view.kind === "server-unreachable" && (
          <div className={styles.unreachableWrap}>
            <span className={styles.pulseDot} />
            <p className={styles.title} style={{ margin: 0 }}>
              Waiting for the local server
            </p>
            <p className={styles.subtitle} style={{ margin: 0 }}>
              Can&apos;t reach the local Notesify server yet. It may still be starting up - this will reconnect
              automatically.
            </p>
          </div>
        )}

        {view.kind === "input" && (
          <form onSubmit={handleSubmit}>
            <p className={styles.title}>Generate handwritten notes</p>
            <p className={styles.subtitle}>Paste a YouTube lecture link and get exam-ready notebook-style PDF notes.</p>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="youtube-url">
                YouTube URL
              </label>
              <input
                id="youtube-url"
                className={`${styles.input} ${urlError ? styles.inputError : ""}`}
                type="text"
                inputMode="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (urlError) setUrlError(null);
                }}
                autoFocus
              />
              {urlError && <p className={styles.fieldError}>{urlError}</p>}
            </div>

            <button type="submit" className={`${styles.button} ${styles.buttonPrimary}`} disabled={submitting || !url.trim()}>
              {submitting ? "Generating..." : "Generate Notes"}
            </button>
            {submitError && <p className={styles.fieldError}>{submitError}</p>}

            <p className={styles.hint}>Works best with lecture videos that have captions. Typically takes 30-60 seconds.</p>
          </form>
        )}

        {view.kind === "progress" && (
          <div>
            <p className={styles.title}>Generating your notes</p>
            {view.reconnecting && (
              <div className={styles.reconnectBanner}>Lost connection to the local server - retrying...</div>
            )}
            <p className={styles.stageLabel}>{STAGE_LABELS[view.status.stage]}</p>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${view.status.progress}%` }} />
            </div>
            <p className={styles.progressPercent}>{view.status.progress}%</p>

            {(view.status.transcriptLength || view.status.notesTitle) && (
              <div className={styles.metaLog}>
                {view.status.transcriptLength && (
                  <p className={styles.metaLine}>
                    transcript: {view.status.transcriptLength} chars via {view.status.transcriptSource}
                  </p>
                )}
                {view.status.notesTitle && (
                  <p className={styles.metaLine}>
                    notes: &quot;{view.status.notesTitle}&quot; - {view.status.pageCount} page(s)
                  </p>
                )}
              </div>
            )}

            <p className={styles.hint}>This usually takes 30-60 seconds. Feel free to leave this open.</p>
          </div>
        )}

        {view.kind === "error" && (
          <div>
            <p className={styles.title}>Generation failed</p>
            <div className={styles.errorBox}>
              <p className={styles.errorTitle}>{view.rateLimited ? "Rate limited" : "Error"}</p>
              <p className={styles.errorMessage}>
                {view.rateLimited ? "Gemini's rate limit was hit - try again in about a minute." : view.message}
              </p>
            </div>
            <button
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={resetToInput}
              disabled={cooldownRemainingMs > 0}
            >
              {cooldownRemainingMs > 0 ? `Try again in ${Math.ceil(cooldownRemainingMs / 1000)}s` : "Try again"}
            </button>
          </div>
        )}

        {view.kind === "done" && (
          <div>
            <div className={styles.doneHeader}>
              <span className={styles.doneCheck}>✓</span>
              <p className={styles.doneTitle}>{view.status.notesTitle || "Your notes are ready"}</p>
            </div>
            {view.status.pageCount && (
              <p className={styles.subtitle} style={{ marginTop: 0 }}>
                {view.status.pageCount} page(s) rendered.
              </p>
            )}

            <div className={styles.actions}>
              <a
                href={downloadUrl(view.jobId)}
                className={`${styles.button} ${styles.buttonPrimary}`}
                style={{ textAlign: "center", textDecoration: "none", display: "block" }}
              >
                Download PDF
              </a>
              <button className={styles.linkButton} onClick={resetToInput}>
                Generate another
              </button>
            </div>

            <div className={styles.previewWrap}>
              <iframe className={styles.previewFrame} src={downloadUrl(view.jobId)} title="Notes preview" />
              <p className={styles.previewFallback}>Preview may not render in every browser - download if it looks blank.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
