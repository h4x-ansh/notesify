import { Preferences } from "@capacitor/preferences";
import type { Language, QualityTier } from "./api";

/**
 * Local, per-device default preferences (language/style/quality tier) -
 * not full history/account state, just "don't make me re-pick the same
 * three choices every time." Two storage backends, same branch pattern
 * lib/transcript.ts already established for window.notesifyBridge:
 *
 * - Electron: no `@capacitor/preferences` native layer exists there (it's
 *   a Capacitor plugin, and this app's Electron build isn't a Capacitor
 *   app) - persisted instead through the same notesifyBridge IPC object
 *   transcript.ts uses, via new getSetting/setSetting methods backed by a
 *   JSON file under Electron's userData dir (see electron/main.js).
 * - Everything else (Capacitor/Android, and plain-browser dev): handled by
 *   `@capacitor/preferences` directly - it ships its own web
 *   implementation (backed by localStorage) for exactly this case, so it
 *   works whether or not this is actually running inside a native
 *   WebView, without a third separate branch.
 */

async function getStoredValue(key: string): Promise<string | null> {
  if (typeof window !== "undefined" && window.notesifyBridge?.getSetting) {
    try {
      return await window.notesifyBridge.getSetting(key);
    } catch {
      return null;
    }
  }
  try {
    const { value } = await Preferences.get({ key });
    return value;
  } catch {
    return null;
  }
}

async function setStoredValue(key: string, value: string): Promise<void> {
  if (typeof window !== "undefined" && window.notesifyBridge?.setSetting) {
    try {
      await window.notesifyBridge.setSetting(key, value);
      return;
    } catch {
      // Fall through to Preferences as a backup rather than losing the
      // write entirely - see below, it's a harmless no-op duplicate write
      // on a real Electron build where the bridge call actually worked.
    }
  }
  try {
    await Preferences.set({ key, value });
  } catch {
    // A failed persist shouldn't crash the settings screen - the app just
    // keeps using in-memory defaults for this session, same as if this
    // were never called at all.
  }
}

const STORAGE_KEY = "notesify.settings.v1";

export interface AppSettings {
  defaultLanguage: Language;
  defaultStyleId: string;
  defaultQualityTier: QualityTier;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultLanguage: "English",
  defaultStyleId: "classic",
  defaultQualityTier: "Normal",
};

/** Never throws - missing/corrupt storage just falls back to DEFAULT_SETTINGS, same as a first-ever launch. */
export async function loadSettings(): Promise<AppSettings> {
  const raw = await getStoredValue(STORAGE_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await setStoredValue(STORAGE_KEY, JSON.stringify(settings));
}
