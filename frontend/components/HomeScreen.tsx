"use client";

import { FileText, NotebookPen } from "lucide-react";
import styles from "./AppShell.module.css";
import type { RecentActivity } from "./AppShell";

interface HomeScreenProps {
  onNewNotes: () => void;
  recentActivity: RecentActivity[];
  onSelectActivity: (activity: RecentActivity) => void;
}

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

/**
 * The new landing point (see AppShell) - a dashboard, not a form. The
 * generate flow (mode-choice -> picker -> progress -> done) is now
 * something launched *from* here via "New Notes," not the app's default
 * state. Recent activity is real cross-session history now (see
 * lib/sessionHistory.ts) - an empty list here means nothing has ever been
 * generated on this device, not just "nothing yet this session."
 */
export default function HomeScreen({ onNewNotes, recentActivity, onSelectActivity }: HomeScreenProps) {
  return (
    <div className={styles.homeRoot}>
      <div className={styles.homeHeader}>
        <p className={styles.homeWordmark}>notesify</p>
        <p className={styles.homeTagline}>Handwritten-style notes from any lecture video.</p>
      </div>

      <button type="button" className={styles.newNotesCard} onClick={onNewNotes}>
        <span className={styles.newNotesIcon}>
          <NotebookPen size={22} strokeWidth={2.25} />
        </span>
        <span>
          <p className={styles.newNotesTitle}>New Notes</p>
          <p className={styles.newNotesSubtitle}>Paste a video or playlist link and get exam-ready notes.</p>
        </span>
      </button>

      <p className={styles.sectionLabel}>Recent notes</p>
      {recentActivity.length === 0 ? (
        <div className={styles.emptyState}>
          <FileText size={22} strokeWidth={1.75} color="var(--pencil-grey)" />
          <p>Nothing generated yet - start with New Notes above.</p>
        </div>
      ) : (
        <div className={styles.recentList}>
          {recentActivity.map((item) => (
            <button
              type="button"
              className={styles.recentItem}
              key={item.jobId}
              onClick={() => onSelectActivity(item)}
            >
              <span className={styles.recentIcon}>
                <FileText size={17} strokeWidth={2} />
              </span>
              <span>
                <p className={styles.recentTitle}>{item.title}</p>
                <p className={styles.recentMeta}>
                  {item.pageCount ? `${item.pageCount} page(s) - ` : ""}
                  {timeAgo(item.completedAt)}
                </p>
              </span>
            </button>
          ))}
        </div>
      )}

      <p className={styles.footerCredit}>dreamed up by hisarchives</p>
    </div>
  );
}
