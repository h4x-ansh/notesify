"use client";

import { PenLine } from "lucide-react";
import styles from "./AppShell.module.css";

/**
 * Purely presentational - AppShell owns the actual timing/init work
 * (loading persisted settings) and decides when to stop rendering this.
 * The "pen writing the app name in" effect is a CSS clip-path reveal
 * (see AppShell.module.css's ink-reveal/pen-travel keyframes) rather than
 * a generic spinner - notebook idiom, not a loading wheel.
 */
export default function SplashScreen() {
  return (
    <div className={styles.splashRoot}>
      <div className={styles.splashWordmarkWrap}>
        <PenLine size={22} className={styles.splashPen} strokeWidth={2.25} />
        <p className={styles.splashWordmark}>notesify</p>
      </div>
      <p className={styles.splashCaption}>hisarchives</p>
    </div>
  );
}
