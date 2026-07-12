"use client";

import { useEffect, useState } from "react";
import shellStyles from "./AppShell.module.css";
import SplashScreen from "./SplashScreen";
import HomeScreen from "./HomeScreen";
import SettingsScreen from "./SettingsScreen";
import BottomNav from "./BottomNav";
import NotesApp from "./NotesApp";
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings";

export type Screen = "home" | "generate" | "settings";

/** One entry per job that reached "done" this session - see NotesApp's onJobCompleted prop. Deliberately not persisted (see HomeScreen's doc comment) - resets on every real app restart, which is the honest behavior for "current-session activity," not a stand-in for real history. */
export interface RecentActivity {
  jobId: string;
  title: string;
  pageCount?: number;
  completedAt: number;
}

const MAX_RECENT_ACTIVITY = 10;
// Splash needs to feel brief (under ~1s perceived) but also cover real
// init work (loading persisted settings) rather than being pure theater -
// this is a floor, not a fixed duration: Promise.all below waits for
// whichever of {this delay, the real settings load} takes longer, so a
// slow settings read still shows the full splash instead of a jarring
// flash, while a fast one doesn't linger past this floor.
const MIN_SPLASH_MS = 550;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Top-level navigation shell (see app/page.tsx) - splash, then a real
 * multi-screen app (Home / New Notes / Settings) behind a bottom tab bar,
 * replacing the old default-straight-into-mode-choice flow. The existing
 * generate flow (NotesApp.tsx's own internal view-state machine, entirely
 * unchanged) is now just the content of the "generate" screen, launched
 * from Home's "New Notes" card or the nav bar's own tab - never the app's
 * default landing state.
 */
export default function AppShell() {
  const [booting, setBooting] = useState(true);
  const [screen, setScreen] = useState<Screen>("home");
  const [settings, setSettings] = useState<AppSettings>({
    defaultLanguage: "English",
    defaultStyleId: "classic",
    defaultQualityTier: "Normal",
  });
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSettings(), delay(MIN_SPLASH_MS)]).then(([loaded]) => {
      if (cancelled) return;
      setSettings(loaded);
      setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSettingsChange(next: AppSettings) {
    setSettings(next);
    saveSettings(next); // fire-and-forget - a failed persist just falls back to defaults next launch (see lib/settings.ts), not worth blocking the UI on
  }

  function handleJobCompleted(summary: RecentActivity) {
    setRecentActivity((prev) => [summary, ...prev].slice(0, MAX_RECENT_ACTIVITY));
  }

  if (booting) return <SplashScreen />;

  return (
    <div className={shellStyles.shellRoot}>
      <div className={shellStyles.screenArea}>
        {screen === "home" && <HomeScreen onNewNotes={() => setScreen("generate")} recentActivity={recentActivity} />}
        {screen === "generate" && (
          <NotesApp
            defaultLanguage={settings.defaultLanguage}
            defaultStyleId={settings.defaultStyleId}
            defaultQualityTier={settings.defaultQualityTier}
            onBack={() => setScreen("home")}
            onJobCompleted={handleJobCompleted}
          />
        )}
        {screen === "settings" && <SettingsScreen settings={settings} onChange={handleSettingsChange} />}
      </div>
      <BottomNav active={screen} onNavigate={setScreen} />
    </div>
  );
}
