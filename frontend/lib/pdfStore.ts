import { Filesystem, Directory } from "@capacitor/filesystem";
import { isNativeMobile, blobToBase64, savePdfOnMobile, type SavePdfResult } from "./downloadPdf";

// Subdirectory under Capacitor's Directory.Data (mobile) - kept separate
// from whatever else might live there, and deliberately Directory.Data
// (persistent, survives app restarts / OS storage-pressure cleanup) rather
// than Directory.Cache, which savePdfOnMobile's own share-then-forget flow
// uses as a throwaway staging area - this is meant to actually last.
const NOTES_DIR = "notes";

export interface PersistedPdf {
  // Electron: an absolute filesystem path under Electron's userData dir
  // (see electron/main.js's "save-pdf" IPC handler). Mobile: a Capacitor
  // file:// URI, as returned by Filesystem.writeFile.
  path: string;
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

/**
 * Writes a just-generated PDF to real, durable on-device storage, keyed by
 * jobId - not the transient Directory.Cache staging savePdfOnMobile uses
 * for its own write-then-immediately-share flow, and not just the
 * in-memory Blob NotesApp's "done" view holds (which is gone the moment
 * that view unmounts, e.g. navigating back to Home). This is what makes a
 * later re-download/share from the session-detail screen a real disk read
 * instead of a silent re-fetch from the backend.
 *
 * Returns null if no persistence backend is available - a plain-browser
 * dev session has neither the Electron bridge nor a real Capacitor native
 * runtime, so persistence degrades to "unavailable" rather than throwing;
 * callers should treat this the same as "re-download won't work for this
 * item," not as an error worth surfacing to the user mid-generation.
 */
export async function persistPdfLocally(jobId: string, filename: string, blob: Blob): Promise<PersistedPdf | null> {
  if (typeof window !== "undefined" && window.notesifyBridge?.savePdf) {
    try {
      const base64 = await blobToBase64(blob);
      const result = await window.notesifyBridge.savePdf(jobId, filename, base64);
      return result ? { path: result.path } : null;
    } catch {
      return null;
    }
  }
  if (isNativeMobile()) {
    try {
      const written = await Filesystem.writeFile({
        path: `${NOTES_DIR}/${jobId}-${filename}`,
        data: await blobToBase64(blob),
        directory: Directory.Data,
        recursive: true,
      });
      return { path: written.uri };
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads back the exact bytes persistPdfLocally wrote - a real disk read each time, not a cache of the original in-memory blob. */
async function readPersistedPdf(path: string): Promise<Blob | null> {
  if (typeof window !== "undefined" && window.notesifyBridge?.readPdf) {
    try {
      const result = await window.notesifyBridge.readPdf(path);
      return result?.data ? base64ToBlob(result.data, "application/pdf") : null;
    } catch {
      return null;
    }
  }
  if (isNativeMobile()) {
    try {
      // No `directory` passed - `path` here is already the full URI
      // returned by writeFile, not a directory-relative one.
      const result = await Filesystem.readFile({ path });
      return typeof result.data === "string" ? base64ToBlob(result.data, "application/pdf") : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * "Re-download" for a persisted item - reads the on-disk file (never the
 * network) and hands it to the user the same way the original generate
 * flow's own "Download PDF" button would have: on mobile, the existing
 * write-to-Cache-then-share flow (savePdfOnMobile, unchanged); on
 * Electron/desktop, the same temporary-anchor-click-a-blob-URL technique
 * the "done" view's download link already relies on under the hood.
 */
export async function reDownloadPersistedPdf(persisted: PersistedPdf, filename: string): Promise<SavePdfResult> {
  const blob = await readPersistedPdf(persisted.path);
  if (!blob) return { status: "error", message: "Couldn't read the saved PDF from this device." };

  if (isNativeMobile()) return savePdfOnMobile(blob, filename);

  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  return { status: "saved", path: persisted.path };
}

/**
 * "Share" for a persisted item - reuses the exact same native share-sheet
 * logic the original generate flow's mobile save button already uses
 * (savePdfOnMobile), just fed bytes read back from disk instead of a
 * freshly-fetched blob. Electron has no native share-sheet concept, so the
 * closest honest equivalent there is revealing the already-saved file in
 * the OS file browser (via the "reveal-file" IPC handler) so the user can
 * attach/send it themselves - falls back to the same re-download behavior
 * if even that bridge method isn't available (e.g. plain-browser dev).
 */
export async function sharePersistedPdf(persisted: PersistedPdf, filename: string): Promise<SavePdfResult> {
  if (isNativeMobile()) {
    const blob = await readPersistedPdf(persisted.path);
    if (!blob) return { status: "error", message: "Couldn't read the saved PDF from this device." };
    return savePdfOnMobile(blob, filename);
  }
  if (typeof window !== "undefined" && window.notesifyBridge?.revealFile) {
    try {
      await window.notesifyBridge.revealFile(persisted.path);
      return { status: "saved", path: persisted.path };
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : "Couldn't open the file location." };
    }
  }
  return reDownloadPersistedPdf(persisted, filename);
}
