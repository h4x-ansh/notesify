"use client";

import { useState } from "react";
import { Download, Share2 } from "lucide-react";
import notesAppStyles from "./NotesApp.module.css";
import styles from "./AppShell.module.css";
import type { RecentActivity } from "./AppShell";
import { extractYoutubeVideoId } from "@/lib/api";
import { reDownloadPersistedPdf, sharePersistedPdf } from "@/lib/pdfStore";
import type { SavePdfResult } from "@/lib/downloadPdf";

interface SessionDetailScreenProps {
  activity: RecentActivity;
  onBack: () => void;
}

function resultMessage(result: SavePdfResult): string {
  if (result.status === "shared") return "Shared.";
  if (result.status === "saved") return "Saved to this device.";
  return result.message;
}

/**
 * Reached by tapping a "This session" item on Home (see AppShell's
 * selectedActivity state) - not a bottom-nav destination of its own, same
 * as the generate flow. Re-download/share both read from the PDF actually
 * persisted to durable on-device storage when the note was originally
 * generated (see lib/pdfStore.ts, wired up in NotesApp.tsx's PDF-fetch
 * effect) - never a re-fetch from the backend, so both still work with no
 * network at all.
 */
export default function SessionDetailScreen({ activity, onBack }: SessionDetailScreenProps) {
  const [busy, setBusy] = useState<"redownload" | "share" | null>(null);
  const [actionResult, setActionResult] = useState<SavePdfResult | null>(null);

  // A thumbnail only makes sense for a genuine single-video entry - a
  // multi-video/batch job (sourceUrls.length !== 1) has no one clean
  // thumbnail to show, so this deliberately skips rather than guessing
  // (e.g. showing just the first video's thumbnail for the whole batch).
  const thumbnailVideoId = activity.sourceUrls.length === 1 ? extractYoutubeVideoId(activity.sourceUrls[0]) : null;

  async function handleReDownload() {
    if (!activity.localPdfPath || busy) return;
    setBusy("redownload");
    setActionResult(null);
    const result = await reDownloadPersistedPdf({ path: activity.localPdfPath }, activity.filename);
    setBusy(null);
    setActionResult(result);
  }

  async function handleShare() {
    if (!activity.localPdfPath || busy) return;
    setBusy("share");
    setActionResult(null);
    const result = await sharePersistedPdf({ path: activity.localPdfPath }, activity.filename);
    setBusy(null);
    setActionResult(result);
  }

  return (
    <div className={notesAppStyles.page}>
      <div className={notesAppStyles.brand}>
        <span className={notesAppStyles.brandMark}>
          <strong>notesify</strong>
        </span>
        <button type="button" className={notesAppStyles.linkButton} onClick={onBack} style={{ marginLeft: "auto" }}>
          &lsaquo; Home
        </button>
      </div>

      <div className={notesAppStyles.card}>
        {thumbnailVideoId && (
          // eslint-disable-next-line @next/next/no-img-element -- a static
          // export has no image-optimization server to point next/image at.
          <img
            className={styles.detailThumb}
            src={`https://img.youtube.com/vi/${thumbnailVideoId}/hqdefault.jpg`}
            alt=""
          />
        )}

        <p className={notesAppStyles.title}>{activity.title}</p>
        {activity.pageCount && (
          <p className={notesAppStyles.subtitle} style={{ marginTop: 0 }}>
            {activity.pageCount} page(s)
          </p>
        )}

        {activity.sourceUrls.length > 0 && (
          <div className={styles.detailUrlBox}>
            {activity.sourceUrls.map((url) => (
              <p key={url} className={styles.detailUrlLine}>
                {url}
              </p>
            ))}
          </div>
        )}

        {!activity.localPdfPath && (
          <p className={notesAppStyles.hint}>
            This PDF wasn&apos;t saved to this device when it was generated, so it isn&apos;t available to re-download
            or share from here.
          </p>
        )}

        <div className={notesAppStyles.actions}>
          <button
            type="button"
            className={`${notesAppStyles.button} ${notesAppStyles.buttonPrimary}`}
            disabled={!activity.localPdfPath || busy !== null}
            onClick={handleReDownload}
          >
            <Download size={16} strokeWidth={2.25} style={{ marginRight: 6, verticalAlign: -3 }} />
            {busy === "redownload" ? "Working..." : "Re-download"}
          </button>
          <button
            type="button"
            className={`${notesAppStyles.button} ${notesAppStyles.buttonGhost}`}
            disabled={!activity.localPdfPath || busy !== null}
            onClick={handleShare}
          >
            <Share2 size={16} strokeWidth={2.25} style={{ marginRight: 6, verticalAlign: -3 }} />
            {busy === "share" ? "Working..." : "Share"}
          </button>
        </div>

        {actionResult && <p className={notesAppStyles.hint}>{resultMessage(actionResult)}</p>}
      </div>
    </div>
  );
}
