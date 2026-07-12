import { Preferences } from "@capacitor/preferences";

/**
 * Generic on-device key -> string persistence, shared by lib/settings.ts
 * and lib/sessionHistory.ts (both just JSON.stringify a small object/array
 * under one fixed key - identical storage need, different key/shape).
 * Same two-backend split as lib/transcript.ts's window.notesifyBridge
 * usage:
 *
 * - Electron: no `@capacitor/preferences` native layer exists there (it's
 *   a Capacitor plugin, and this app's Electron build isn't a Capacitor
 *   app) - persisted instead through the notesifyBridge IPC object,
 *   backed by a JSON file under Electron's userData dir (see
 *   electron/main.js's get-setting/set-setting handlers - a plain flat
 *   key/value store, not specific to settings despite the handler names).
 * - Everything else (Capacitor/Android, and plain-browser dev): handled by
 *   `@capacitor/preferences` directly - it ships its own web
 *   implementation (backed by localStorage) for exactly this case, so it
 *   works whether or not this is actually running inside a native
 *   WebView, without a third separate branch.
 */

export async function getStoredValue(key: string): Promise<string | null> {
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

export async function setStoredValue(key: string, value: string): Promise<void> {
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
    // A failed persist shouldn't crash the caller - it just keeps using
    // whatever in-memory state it already had, same as if this were
    // never called at all.
  }
}
