"use client";

import { PenLine } from "lucide-react";
import styles from "./AppShell.module.css";

interface SplashScreenProps {
  // Set once AppShell's health-check wait has run noticeably long (see
  // AppShell.tsx's WAKING_MESSAGE_DELAY_MS) - a real, honest status update
  // rather than a generic spinner, so a cold Render backend doesn't make
  // the splash look frozen.
  statusMessage?: string;
}

/**
 * Purely presentational - AppShell owns the actual timing/init work
 * (loading persisted settings, polling server health) and decides when to
 * stop rendering this. The "pen writing the app name in" effect is a CSS
 * clip-path reveal (see AppShell.module.css's ink-reveal/pen-travel
 * keyframes) rather than a generic spinner - notebook idiom, not a
 * loading wheel.
 */
export default function SplashScreen({ statusMessage }: SplashScreenProps) {
  return (
    <div className={styles.splashRoot}>
      <div className={styles.splashWordmarkWrap}>
        <PenLine size={22} className={styles.splashPen} strokeWidth={2.25} />
        <p className={styles.splashWordmark}>notesify</p>
      </div>
      {statusMessage && <p className={styles.splashStatus}>{statusMessage}</p>}
    </div>
  );
}
