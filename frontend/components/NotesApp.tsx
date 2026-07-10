"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./NotesApp.module.css";
import {
  ApiError,
  checkHealth,
  fetchPdf,
  generateNotes,
  getStatus,
  IS_HOSTED_BACKEND,
  isRateLimitError,
  looksLikeYoutubeUrl,
  type Stage,
  type StatusResponse,
} from "@/lib/api";
import { fetchTranscriptClientSide } from "@/lib/transcript";
import { isNativeMobile, savePdfOnMobile, type SavePdfResult } from "@/lib/downloadPdf";

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
  const [submitPhase, setSubmitPhase] = useState<"transcript" | "starting" | null>(null);

  const pollFailuresRef = useRef(0);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const [pdf, setPdf] = useState<
    | { status: "loading" }
    | { status: "ready"; blob: Blob; blobUrl: string; filename: string }
    | { status: "error" }
  >({ status: "loading" });
  const [pdfRetryTick, setPdfRetryTick] = useState(0);
  const [mobileSave, setMobileSave] = useState<SavePdfResult | { status: "idle" } | { status: "saving" }>({
    status: "idle",
  });

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

  // Fetch the PDF as an authenticated blob once a job is done - a plain
  // <a href>/<iframe src> can't carry the X-API-Secret header the hosted
  // backend requires (see fetchPdf in lib/api.ts). The object URL built
  // here is only ever used for the Electron/desktop download link and the
  // preview iframe - the mobile save/share flow (see the "done" view below)
  // uses the raw Blob directly instead, since blob: URLs don't produce any
  // visible behavior when tapped in Android's WebView.
  useEffect(() => {
    if (view.kind !== "done") return;
    const jobId = view.jobId;
    let cancelled = false;
    let objectUrl: string | null = null;

    setPdf({ status: "loading" });
    setMobileSave({ status: "idle" });
    fetchPdf(jobId)
      .then(({ blob, filename }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdf({ status: "ready", blob, blobUrl: objectUrl, filename });
      })
      .catch(() => {
        if (!cancelled) setPdf({ status: "error" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [view.kind === "done" ? view.jobId : null, pdfRetryTick]);

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
      // Try fetching captions ourselves first - on the client's own IP
      // (Electron: the user's machine via main-process IPC; mobile: the
      // device's own network via CapacitorHttp) rather than the hosted
      // backend's, which is what YouTube has been blocking (see the
      // caption-fetch investigation and client-side transcript-fetch
      // sections in the root README). A failure here isn't an error state -
      // it's expected and handled by simply not sending a transcript, which
      // makes the server fall back to its own captions-then-yt-dlp attempt
      // exactly as before.
      setSubmitPhase("transcript");
      const clientTranscript = await fetchTranscriptClientSide(url.trim());

      setSubmitPhase("starting");
      const { jobId } = await generateNotes(url.trim(), clientTranscript);
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
      setSubmitPhase(null);
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
              {IS_HOSTED_BACKEND ? "Connecting..." : "Connecting to local server..."}
            </p>
          </div>
        )}

        {view.kind === "server-unreachable" && (
          <div className={styles.unreachableWrap}>
            <span className={styles.pulseDot} />
            <p className={styles.title} style={{ margin: 0 }}>
              {IS_HOSTED_BACKEND ? "Waking up the server" : "Waiting for the local server"}
            </p>
            <p className={styles.subtitle} style={{ margin: 0 }}>
              {IS_HOSTED_BACKEND
                ? "The hosted server spins down after a period of inactivity - the first request can take up to a minute to wake it back up. This will reconnect automatically."
                : "Can't reach the local Notesify server yet. It may still be starting up - this will reconnect automatically."}
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
              {submitPhase === "transcript"
                ? "Fetching transcript..."
                : submitting
                  ? "Generating..."
                  : "Generate Notes"}
            </button>
            {submitError && <p className={styles.fieldError}>{submitError}</p>}

            <p className={styles.hint}>Works best with lecture videos that have captions. Typically takes 30-60 seconds.</p>
          </form>
        )}

        {view.kind === "progress" && (
          <div>
            <p className={styles.title}>Generating your notes</p>
            {view.reconnecting && (
              <div className={styles.reconnectBanner}>
                Lost connection to the {IS_HOSTED_BACKEND ? "" : "local "}server - retrying...
              </div>
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
              {pdf.status === "ready" ? (
                isNativeMobile() ? (
                  // A blob: URL (the Electron/desktop path below) produces
                  // no visible save/open behavior when tapped inside
                  // Android's WebView - this was the actual bug. Write +
                  // share instead (lib/downloadPdf.ts), triggered by the
                  // tap itself rather than automatically on load, since
                  // that's the expected moment for a share sheet to appear.
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    disabled={mobileSave.status === "saving"}
                    onClick={async () => {
                      setMobileSave({ status: "saving" });
                      const result = await savePdfOnMobile(pdf.blob, pdf.filename);
                      setMobileSave(result);
                    }}
                  >
                    {mobileSave.status === "saving" ? "Saving..." : "Download PDF"}
                  </button>
                ) : (
                  <a
                    href={pdf.blobUrl}
                    download={pdf.filename}
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    style={{ textAlign: "center", textDecoration: "none", display: "block" }}
                  >
                    Download PDF
                  </a>
                )
              ) : (
                <button className={`${styles.button} ${styles.buttonPrimary}`} disabled>
                  {pdf.status === "loading" ? "Preparing download..." : "Couldn't load PDF"}
                </button>
              )}
              <button className={styles.linkButton} onClick={resetToInput}>
                Generate another
              </button>
            </div>

            {pdf.status === "error" && (
              <div className={styles.errorBox} style={{ marginTop: 16 }}>
                <p className={styles.errorMessage}>
                  Couldn&apos;t load the PDF -{" "}
                  <button className={styles.linkButton} style={{ display: "inline" }} onClick={() => setPdfRetryTick((n) => n + 1)}>
                    try again
                  </button>
                  .
                </p>
              </div>
            )}

            {mobileSave.status === "shared" && <p className={styles.hint}>Shared.</p>}
            {mobileSave.status === "saved" && (
              <p className={styles.hint}>Saved to the app&apos;s cache - use the share sheet to move it somewhere permanent.</p>
            )}
            {mobileSave.status === "error" && (
              <div className={styles.errorBox} style={{ marginTop: 16 }}>
                <p className={styles.errorMessage}>
                  Couldn&apos;t save the PDF - {mobileSave.message}{" "}
                  <button className={styles.linkButton} style={{ display: "inline" }} onClick={() => setMobileSave({ status: "idle" })}>
                    try again
                  </button>
                  .
                </p>
              </div>
            )}

            {pdf.status === "ready" && (
              <div className={styles.previewWrap}>
                <iframe className={styles.previewFrame} src={pdf.blobUrl} title="Notes preview" />
                <p className={styles.previewFallback}>Preview may not render in every browser - download if it looks blank.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
