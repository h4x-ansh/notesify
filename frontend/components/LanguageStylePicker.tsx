"use client";

import { useState } from "react";
import styles from "./NotesApp.module.css";
import { SUPPORTED_LANGUAGES, STYLE_PRESETS, type Language } from "@/lib/api";

interface LanguageStylePickerProps {
  onBack: () => void;
  onGenerate: (language: Language, styleId: string) => void;
  submitting: boolean;
  submitLabel?: string;
}

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

      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        onClick={() => onGenerate(language, styleId)}
        disabled={submitting}
      >
        {submitting ? submitLabel : "Generate Notes"}
      </button>

      <p className={styles.hint}>Works best with lecture videos that have captions. Typically takes 30-60 seconds.</p>
    </div>
  );
}
