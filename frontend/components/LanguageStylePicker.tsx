"use client";

import { useState } from "react";
import styles from "./NotesApp.module.css";
import { SUPPORTED_LANGUAGES, SUPPORTED_QUALITY_TIERS, STYLE_PRESETS, type Language, type QualityTier } from "@/lib/api";

interface LanguageStylePickerProps {
  onBack: () => void;
  onGenerate: (language: Language, styleId: string, qualityTier: QualityTier) => void;
  submitting: boolean;
  submitLabel?: string;
}

// Short, plain-language hint per tier - "High/Normal/Low" alone doesn't
// tell a user what they're actually trading off (which provider, whether
// it can run out for the day) - see src/notesGenerator.js's
// buildProvidersForTier for the real mapping/cascade rules this describes.
const QUALITY_TIER_HINTS: Record<QualityTier, string> = {
  High: "Best quality (Gemini Flash). Limited daily uses - fails clearly instead of downgrading silently if unavailable.",
  Normal: "Balanced quality and availability. Falls back automatically if the first provider is busy.",
  Low: "Fastest/most available, lighter model. Good for quick drafts.",
};

/**
 * Sits between video selection (single-video input or the multi-link
 * screen) and the actual pipeline start - both paths land here now, and
 * neither calls the API until this screen's "Generate" is pressed (see
 * NotesApp.tsx's handleGenerate, which is where the client-side transcript
 * pre-fetch and the real generateNotes/generateNotesBatch calls now live).
 */
export default function LanguageStylePicker({ onBack, onGenerate, submitting, submitLabel = "Generate Notes" }: LanguageStylePickerProps) {
  const [language, setLanguage] = useState<Language>("English");
  const [styleId, setStyleId] = useState<string>(STYLE_PRESETS[0].id);
  const [qualityTier, setQualityTier] = useState<QualityTier>("Normal");

  return (
    <div>
      <button type="button" className={styles.linkButton} onClick={onBack} style={{ marginBottom: 16 }} disabled={submitting}>
        &lsaquo; Back
      </button>
      <p className={styles.title}>Language &amp; style</p>
      <p className={styles.subtitle}>Pick how your notes should read and look, then generate.</p>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="language-select">
          Notes language
        </label>
        <select
          id="language-select"
          className={styles.input}
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          disabled={submitting}
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Visual style</label>
        <div className={styles.actions} style={{ marginTop: 0 }}>
          {STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`${styles.button} ${styleId === preset.id ? styles.buttonPrimary : styles.buttonGhost}`}
              onClick={() => setStyleId(preset.id)}
              disabled={submitting}
              aria-pressed={styleId === preset.id}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Note quality</label>
        <div className={styles.actions} style={{ marginTop: 0 }}>
          {SUPPORTED_QUALITY_TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              className={`${styles.button} ${qualityTier === tier ? styles.buttonPrimary : styles.buttonGhost}`}
              onClick={() => setQualityTier(tier)}
              disabled={submitting}
              aria-pressed={qualityTier === tier}
            >
              {tier}
            </button>
          ))}
        </div>
        <p className={styles.hint} style={{ marginTop: 8 }}>
          {QUALITY_TIER_HINTS[qualityTier]}
        </p>
      </div>

      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        onClick={() => onGenerate(language, styleId, qualityTier)}
        disabled={submitting}
      >
        {submitting ? submitLabel : "Generate Notes"}
      </button>

      <p className={styles.hint}>Works best with lecture videos that have captions. Typically takes 30-60 seconds.</p>
    </div>
  );
}
