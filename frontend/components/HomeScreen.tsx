"use client";

import { FileText, NotebookPen } from "lucide-react";
import styles from "./AppShell.module.css";
import type { RecentActivity } from "./AppShell";

interface HomeScreenProps {
  onNewNotes: () => void;
  recentActivity: RecentActivity[];
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
 * state. Recent activity is honestly session-only - AppShell doesn't
 * persist it anywhere, so an empty list here just means nothing has
 * finished generating yet this session, not "no data yet, fake some in."
 */
export default function HomeScreen({ onNewNotes, recentActivity }: HomeScreenProps) {
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

      <p className={styles.sectionLabel}>This session</p>
      {recentActivity.length === 0 ? (
        <div className={styles.emptyState}>
          <FileText size={22} strokeWidth={1.75} color="var(--pencil-grey)" />
          <p>Nothing generated yet this session - start with New Notes above.</p>
        </div>
      ) : (
        <div className={styles.recentList}>
          {recentActivity.map((item) => (
            <div className={styles.recentItem} key={item.jobId}>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
