"use client";

import { useEffect, useRef, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import shellStyles from "./AppShell.module.css";
import SplashScreen from "./SplashScreen";
import HomeScreen from "./HomeScreen";
import SettingsScreen from "./SettingsScreen";
import SessionDetailScreen from "./SessionDetailScreen";
import BottomNav from "./BottomNav";
import NotesApp from "./NotesApp";
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings";
import { loadSessionHistory, saveSessionHistory, MAX_HISTORY_ENTRIES } from "@/lib/sessionHistory";
import { checkHealth, IS_HOSTED_BACKEND } from "@/lib/api";
import { isNativeMobile } from "@/lib/downloadPdf";

export type Screen = "home" | "generate" | "settings";

/**
 * One entry per completed generation - see NotesApp's onJobCompleted prop.
 * Persisted across app restarts (see lib/sessionHistory.ts, loaded in
 * AppShell's boot effect and saved every time handleJobCompleted fires) -
 * despite the name (kept for now to avoid a churny rename across every
 * file that references it), this is real cross-session history, not just
 * current-session activity: each entry's `localPdfPath` points at a PDF
 * already durably persisted on-device (see lib/pdfStore.ts), so
 * re-download/share from an old entry still work after a restart, as long
 * as the underlying file wasn't otherwise removed from the device.
 */
export interface RecentActivity {
  jobId: string;
  title: string;
  pageCount?: number;
  completedAt: number;
  // The source video URL(s) this job was generated from - single-video-only
  // (see NotesApp's jobSourcesRef doc comment), so always a 1-element array
  // in practice today, but plural since this shape is meant to also cover
  // a future multi-video/batch entry rather than needing a second field.
  sourceUrls: string[];
  filename: string;
  // Absolute path (Electron) / Capacitor file:// URI (mobile) of the PDF as
  // actually written to durable on-device storage - see lib/pdfStore.ts.
  // Null when persistence failed or wasn't available (e.g. plain-browser
  // dev) - the detail screen's re-download/share just can't work for that
  // item, same graceful-degradation policy pdfStore.ts itself uses.
  localPdfPath: string | null;
}

// The splash's own CSS animation timeline (see AppShell.module.css's
// .splashWordmark/.splashPen) - mirrored here rather than shared, since CSS
// keyframe timing and a JS setTimeout value have no common source of truth
// without build tooling this project doesn't use - if those durations/
// delays change, this must change too.
const INK_REVEAL_DELAY_MS = 150; // .splashWordmark/.splashPen animation-delay
const INK_REVEAL_DURATION_MS = 900; // .splashWordmark/.splashPen animation duration
const SPLASH_ANIMATION_END_MS = INK_REVEAL_DELAY_MS + INK_REVEAL_DURATION_MS;
// Measured directly (sampling the wordmark's live computed clip-path via
// Puppeteer, not assumed from CSS math) - the animation didn't visually
// finish until ~1440-1470ms after navigation start on a real build, well
// past the naive 1100ms (delay+duration) figure - JS parse/hydration time
// before the component even mounts and starts its animation-delay clock
// eats into the budget a pure CSS calculation doesn't account for.
const ANIMATION_COMPLETE_MS = SPLASH_ANIMATION_END_MS + 400;

// Splash now doubles as the server wake-up wait, absorbing what used to be
// a separate "connecting to server" screen shown after splash (see
// NotesApp.tsx's initialServerHealthy prop, which skips that redundant
// second check once this has already confirmed the server). Dismissal
// rule: (the animation has finished AND the health check succeeded), OR
// this hard cap has elapsed, whichever comes first - a cold Render
// instance can take a while to wake up, but this must never trap the user
// on the splash indefinitely; give up and hand off to Home/NotesApp's own
// existing error/retry UI instead.
const MAX_HEALTH_WAIT_MS = 18000;
// Matches NotesApp.tsx's own HEALTH_RETRY_MS - same cadence, since this is
// the same kind of retry-until-healthy loop, just bounded by the cap above
// instead of running forever.
const HEALTH_RETRY_MS = 2000;
// "A few seconds" per spec - comfortably after the animation's own ~1.7s
// natural completion, so this text never flashes in during a normal,
// fast, warm-backend load, only once the wait has become noticeable.
const WAKING_MESSAGE_DELAY_MS = 3500;

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
  const [wakingMessage, setWakingMessage] = useState<string | null>(null);
  const [serverHealthy, setServerHealthy] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [settings, setSettings] = useState<AppSettings>({
    defaultLanguage: "English",
    defaultStyleId: "classic",
    defaultQualityTier: "Normal",
  });
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  // The session-item currently open in the detail screen, or null when
  // none is - an overlay on top of whatever `screen` tab is active
  // (always "home" in practice, since that's the only place items are
  // tappable) rather than its own Screen union member, since it isn't a
  // bottom-nav destination - mirrors how "generate" already works as a
  // screen reached *from* Home rather than a tab of its own concern.
  const [selectedActivity, setSelectedActivity] = useState<RecentActivity | null>(null);
  // The generate flow's own current back-step, as registered by NotesApp
  // (see its registerBackHandler prop) - null whenever "generate" isn't
  // the active screen, or before NotesApp's first render has registered
  // one. A ref, not state: this changes on every NotesApp view transition
  // and is only ever read from the hardware-back-button handler below, not
  // rendered - putting it in state would just cause pointless re-renders.
  const notesAppBackRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let dismissed = false;
    let animationDone = false;
    let healthOk = false;

    function dismiss() {
      if (dismissed || cancelled) return;
      dismissed = true;
      setBooting(false);
    }

    function maybeDismiss() {
      if (animationDone && healthOk) dismiss();
    }

    // Hard cap - fires no matter what state the health check is in, so a
    // dead/unreachable backend (or one that never wakes up in time)
    // doesn't trap the user here - Home/NotesApp's own existing
    // error/retry UI takes over once the flow actually needs the server.
    const capTimer = setTimeout(dismiss, MAX_HEALTH_WAIT_MS);

    const wakingTimer = setTimeout(() => {
      if (!cancelled && !dismissed) {
        setWakingMessage(IS_HOSTED_BACKEND ? "Waking up the server..." : "Waiting for the local server...");
      }
    }, WAKING_MESSAGE_DELAY_MS);

    const animTimer = setTimeout(() => {
      animationDone = true;
      maybeDismiss();
    }, ANIMATION_COMPLETE_MS);

    async function pollHealth() {
      while (!cancelled && !dismissed) {
        const ok = await checkHealth();
        if (cancelled || dismissed) return;
        if (ok) {
          healthOk = true;
          setServerHealthy(true);
          maybeDismiss();
          return;
        }
        await delay(HEALTH_RETRY_MS);
      }
    }
    pollHealth();

    // Real init work (loading persisted defaults/history) - independent of
    // the health-check/animation race above; in practice always far faster
    // than either, so it's never the bottleneck for dismissal.
    loadSettings().then((loaded) => {
      if (!cancelled) setSettings(loaded);
    });
    loadSessionHistory().then((loaded) => {
      if (!cancelled) setRecentActivity(loaded);
    });

    return () => {
      cancelled = true;
      clearTimeout(capTimer);
      clearTimeout(wakingTimer);
      clearTimeout(animTimer);
    };
  }, []);

  // Hardware/gesture back button (Android only - see the addListener
  // effect below) needs to see the *current* screen/overlay state, but
  // that effect only registers its listener once (native back-button
  // wiring shouldn't be torn down and re-added on every render) - so the
  // handler itself lives in a ref, reassigned fresh every render, and the
  // listener just calls whatever's currently in the ref. Not memoized:
  // this is cheap, and correctness (always seeing the latest screen/
  // selectedActivity/etc.) matters more here than avoiding a function
  // allocation per render.
  function handleHardwareBack() {
    // A session-detail screen is an overlay on top of whatever `screen`
    // tab is showing (see selectedActivity below) - closing it is always
    // the first back step, regardless of which tab it was opened from.
    if (selectedActivity) {
      setSelectedActivity(null);
      return;
    }
    // The generate flow owns a whole sub-navigation stack of its own
    // (mode-choice -> input/multi-link -> picker -> ...) - NotesApp's
    // registered handler already knows whether to step back within that
    // stack or bubble out to Home (see NotesApp's goBack/onBack), so this
    // just delegates entirely rather than re-implementing that logic here.
    if (screen === "generate") {
      notesAppBackRef.current?.();
      return;
    }
    if (screen !== "home") {
      setScreen("home");
      return;
    }
    // Already at the root (Home, nothing open on top of it) - genuinely
    // nowhere left to go back to, so this is where back actually exits.
    CapacitorApp.exitApp();
  }
  const handleHardwareBackRef = useRef(handleHardwareBack);
  handleHardwareBackRef.current = handleHardwareBack;

  useEffect(() => {
    // Only Android has a hardware/gesture back button to intercept in the
    // first place - registering this on Electron/plain-browser would be
    // harmless (the 'backButton' event simply never fires there) but
    // pointless, so it's skipped entirely rather than adding a listener
    // that can never do anything.
    if (!isNativeMobile()) return;
    let removed = false;
    let handle: { remove: () => void } | null = null;
    CapacitorApp.addListener("backButton", () => handleHardwareBackRef.current()).then((h) => {
      if (removed) {
        h.remove();
        return;
      }
      handle = h;
    });
    return () => {
      removed = true;
      handle?.remove();
    };
  }, []);

  function handleSettingsChange(next: AppSettings) {
    setSettings(next);
    saveSettings(next); // fire-and-forget - a failed persist just falls back to defaults next launch (see lib/settings.ts), not worth blocking the UI on
  }

  function handleJobCompleted(summary: RecentActivity) {
    setRecentActivity((prev) => {
      const next = [summary, ...prev].slice(0, MAX_HISTORY_ENTRIES);
      saveSessionHistory(next); // fire-and-forget, same policy as handleSettingsChange above
      return next;
    });
  }

  if (booting) return <SplashScreen statusMessage={wakingMessage ?? undefined} />;

  return (
    <div className={shellStyles.shellRoot}>
      <div className={shellStyles.screenArea}>
        {selectedActivity ? (
          <SessionDetailScreen activity={selectedActivity} onBack={() => setSelectedActivity(null)} />
        ) : (
          <>
            {screen === "home" && (
              <HomeScreen
                onNewNotes={() => setScreen("generate")}
                recentActivity={recentActivity}
                onSelectActivity={setSelectedActivity}
              />
            )}
            {screen === "generate" && (
              <NotesApp
                defaultLanguage={settings.defaultLanguage}
                defaultStyleId={settings.defaultStyleId}
                defaultQualityTier={settings.defaultQualityTier}
                initialServerHealthy={serverHealthy}
                onBack={() => setScreen("home")}
                onJobCompleted={handleJobCompleted}
                registerBackHandler={(fn) => {
                  notesAppBackRef.current = fn;
                }}
              />
            )}
            {screen === "settings" && <SettingsScreen settings={settings} onChange={handleSettingsChange} />}
          </>
        )}
      </div>
      <BottomNav
        active={screen}
        onNavigate={(next) => {
          // A tab tap always means "go to the root of this tab" - closing
          // whatever overlay (the session-detail screen) was open on top
          // of the previous one, same as the hardware-back handler treats
          // selectedActivity as the top of the navigation stack. Without
          // this, tapping a tab while the detail screen was open silently
          // did nothing visible, since selectedActivity kept overriding
          // the screenArea's render regardless of `screen`.
          setSelectedActivity(null);
          setScreen(next);
        }}
      />
    </div>
  );
}
