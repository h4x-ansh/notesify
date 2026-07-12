"use client";

import { KeyRound } from "lucide-react";
import notesAppStyles from "./NotesApp.module.css";
import styles from "./AppShell.module.css";
import { SUPPORTED_LANGUAGES, SUPPORTED_QUALITY_TIERS, STYLE_PRESETS, type QualityTier } from "@/lib/api";
import type { AppSettings } from "@/lib/settings";

interface SettingsScreenProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

// Bumped by hand alongside package.json's own "version" field - a static
// export can't read package.json at runtime (see next.config.mjs's
// output:"export"), so this is the simplest way to show something real
// here without wiring up a build-time env-var injection just for an
// about screen.
const APP_VERSION = "0.1.0";

/**
 * New screen (see AppShell) - default language/style/quality-tier
 * preferences (persisted via lib/settings.ts, read back by LanguageStylePicker
 * as its initial selection - see NotesApp.tsx's defaultLanguage/defaultStyleId/
 * defaultQualityTier props), an about/version block, and a BYOK (bring-your-
 * own-key) placeholder that's visually present but honestly labeled
 * "Coming soon" rather than wired to fake functionality - no API-key input
 * exists anywhere in this app yet.
 */
export default function SettingsScreen({ settings, onChange }: SettingsScreenProps) {
  return (
    <div className={styles.settingsRoot}>
      <p className={notesAppStyles.title}>Settings</p>
      <p className={notesAppStyles.subtitle}>Defaults apply next time you start New Notes - preferences save automatically.</p>

      <div className={styles.settingsSection}>
        <p className={styles.settingsSectionTitle}>Defaults</p>
        <p className={styles.settingsSectionHint}>Used to pre-fill the language/style/quality picker - still changeable per generation.</p>

        <div className={notesAppStyles.field}>
          <label className={notesAppStyles.label} htmlFor="default-language-select">
            Default language
          </label>
          <select
            id="default-language-select"
            className={notesAppStyles.input}
            value={settings.defaultLanguage}
            onChange={(e) => onChange({ ...settings, defaultLanguage: e.target.value as AppSettings["defaultLanguage"] })}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
        </div>

        <div className={notesAppStyles.field}>
          <label className={notesAppStyles.label}>Default visual style</label>
          <div className={notesAppStyles.actions} style={{ marginTop: 0 }}>
            {STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`${notesAppStyles.button} ${
                  settings.defaultStyleId === preset.id ? notesAppStyles.buttonPrimary : notesAppStyles.buttonGhost
                }`}
                onClick={() => onChange({ ...settings, defaultStyleId: preset.id })}
                aria-pressed={settings.defaultStyleId === preset.id}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className={notesAppStyles.field} style={{ marginBottom: 0 }}>
          <label className={notesAppStyles.label}>Default note quality</label>
          <div className={notesAppStyles.actions} style={{ marginTop: 0 }}>
            {SUPPORTED_QUALITY_TIERS.map((tier: QualityTier) => (
              <button
                key={tier}
                type="button"
                className={`${notesAppStyles.button} ${
                  settings.defaultQualityTier === tier ? notesAppStyles.buttonPrimary : notesAppStyles.buttonGhost
                }`}
                onClick={() => onChange({ ...settings, defaultQualityTier: tier })}
                aria-pressed={settings.defaultQualityTier === tier}
              >
                {tier}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.settingsSection}>
        <p className={styles.settingsSectionTitle}>Your API key (BYOK)</p>
        <p className={styles.settingsSectionHint}>Bring your own Gemini/Groq key instead of the shared one.</p>
        <div className={styles.byokRow}>
          <span className={styles.byokLabel}>
            <KeyRound size={14} style={{ marginRight: 6, verticalAlign: -2 }} strokeWidth={2} />
            API key
          </span>
          <span className={styles.comingSoonBadge}>Coming soon</span>
        </div>
      </div>

      <div className={styles.settingsSection}>
        <p className={styles.settingsSectionTitle}>About</p>
        <div className={styles.aboutRow}>
          <span className={styles.aboutKey}>App</span>
          <span className={styles.aboutValue}>hisarchives / notesify</span>
        </div>
        <div className={styles.aboutRow}>
          <span className={styles.aboutKey}>Version</span>
          <span className={styles.aboutValue}>{APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
}
