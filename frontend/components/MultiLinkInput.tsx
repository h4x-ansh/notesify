"use client";

import { useState } from "react";
import styles from "./NotesApp.module.css";
import { looksLikeYoutubeUrl, type BatchPayload } from "@/lib/api";

interface MultiLinkInputProps {
  onBack: () => void;
  onSubmit: (payload: BatchPayload) => void;
  submitting: boolean;
}

type LinkKind = "empty" | "single" | "playlist" | "invalid";

// A playlist is any youtube.com/youtu.be link carrying a ?list= param -
// including a "watch a video within a playlist" URL, which otherwise also
// matches looksLikeYoutubeUrl below. Checked first so that case resolves
// to "playlist", not "single".
const YOUTUBE_HOST_PATTERN = /(youtube\.com|youtu\.be)/i;
const LIST_PARAM_PATTERN = /[?&]list=[\w-]+/i;

function classifyLink(raw: string): LinkKind {
  const trimmed = raw.trim();
  if (!trimmed) return "empty";
  if (YOUTUBE_HOST_PATTERN.test(trimmed) && LIST_PARAM_PATTERN.test(trimmed)) return "playlist";
  if (looksLikeYoutubeUrl(trimmed)) return "single";
  return "invalid";
}

let fieldIdCounter = 0;

/**
 * The "Multiple videos" collection screen (see NotesApp.tsx's mode-choice
 * view). One field to start; each field independently classifies as it's
 * typed into. A playlist link is treated as the complete batch on its own
 * (a playlist already contains many videos - it doesn't make sense to mix
 * it with individually-picked links) and locks out adding more fields.
 * Otherwise, each valid single-video link unlocks "Add more" for another
 * one, building up `videoUrls`.
 *
 * No "Next" here leads anywhere but straight to submission - there's no
 * language/style picker screen yet (a later step, out of scope here), so
 * this is the last stop before the same progress/done/error views the
 * single-video flow already uses.
 */
export default function MultiLinkInput({ onBack, onSubmit, submitting }: MultiLinkInputProps) {
  const [fields, setFields] = useState<{ id: number; value: string }[]>(() => [{ id: fieldIdCounter++, value: "" }]);

  const kinds = fields.map((f) => classifyLink(f.value));
  const playlistIndex = kinds.findIndex((k) => k === "playlist");
  const isPlaylistLocked = playlistIndex !== -1;
  const hasInvalid = kinds.some((k) => k === "invalid");
  const singleUrls = fields.filter((_, i) => kinds[i] === "single").map((f) => f.value.trim());
  const lastFieldKind = kinds[kinds.length - 1];

  const canAddMore = !isPlaylistLocked && !hasInvalid && lastFieldKind === "single";
  const canProceed = isPlaylistLocked || (!hasInvalid && singleUrls.length > 0);

  function updateField(id: number, value: string) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, value } : f)));
  }

  function addField() {
    setFields((prev) => [...prev, { id: fieldIdCounter++, value: "" }]);
  }

  function handleNext() {
    if (!canProceed) return;
    if (isPlaylistLocked) {
      onSubmit({ playlistUrl: fields[playlistIndex].value.trim() });
    } else {
      onSubmit({ videoUrls: singleUrls });
    }
  }

  return (
    <div>
      <button type="button" className={styles.linkButton} onClick={onBack} style={{ marginBottom: 16 }}>
        &lsaquo; Back
      </button>
      <p className={styles.title}>Add your videos</p>
      <p className={styles.subtitle}>
        Paste a playlist link to use the whole playlist, or paste individual video links one at a time.
      </p>

      {fields.map((field, i) => {
        const kind = kinds[i];
        const isPlaylistField = i === playlistIndex;
        const locked = isPlaylistLocked && !isPlaylistField;
        return (
          <div className={styles.field} key={field.id}>
            <label className={styles.label} htmlFor={`multi-link-${field.id}`}>
              {kind === "playlist" ? "Playlist URL" : `Video link ${i + 1}`}
            </label>
            <input
              id={`multi-link-${field.id}`}
              className={`${styles.input} ${kind === "invalid" ? styles.inputError : ""}`}
              type="text"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=... or a playlist link"
              value={field.value}
              onChange={(e) => updateField(field.id, e.target.value)}
              disabled={submitting || locked}
              autoFocus={i === 0}
            />
            {kind === "invalid" && <p className={styles.fieldError}>That doesn&apos;t look like a YouTube link.</p>}
          </div>
        );
      })}

      {isPlaylistLocked && fields.length > 1 && (
        <p className={styles.hint}>
          A playlist link covers the whole batch on its own - the other link(s) above will be ignored.
        </p>
      )}

      <div className={styles.actions}>
        {!isPlaylistLocked && (
          <button
            type="button"
            className={`${styles.button} ${styles.buttonGhost}`}
            onClick={addField}
            disabled={submitting || !canAddMore}
          >
            Add more
          </button>
        )}
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={handleNext}
          disabled={submitting || !canProceed}
        >
          {submitting ? "Starting..." : "Next"}
        </button>
      </div>

      {!isPlaylistLocked && (
        <p className={styles.hint}>
          {singleUrls.length > 0
            ? `${singleUrls.length} video link${singleUrls.length === 1 ? "" : "s"} added so far.`
            : "Paste a YouTube video or playlist link to get started."}
        </p>
      )}
    </div>
  );
}
