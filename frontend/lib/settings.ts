import { getStoredValue, setStoredValue } from "./localKV";
import type { Language, QualityTier } from "./api";

/**
 * Local, per-device default preferences (language/style/quality tier) -
 * not full history/account state, just "don't make me re-pick the same
 * three choices every time." Storage itself lives in lib/localKV.ts
 * (shared with lib/sessionHistory.ts).
 */

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
