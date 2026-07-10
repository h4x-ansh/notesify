import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export type SavePdfResult =
  | { status: "shared" }
  | { status: "saved"; path: string }
  | { status: "error"; message: string };

/**
 * `Capacitor.isNativePlatform()` is false in Electron and in a plain
 * browser alike (it only reports true inside an actual Capacitor-wrapped
 * native app), so this cleanly picks out "mobile build, actually running
 * on a device" without needing a separate build-time flag.
 */
export function isNativeMobile(): boolean {
  return Capacitor.isNativePlatform();
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // readAsDataURL() prefixes with "data:application/pdf;base64," -
      // Filesystem.writeFile() wants the raw base64 payload, not a data URL.
      const base64 = result.slice(result.indexOf(",") + 1);
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read PDF data"));
    reader.readAsDataURL(blob);
  });
}

function isUserCancelled(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(message);
}

/**
 * Mobile-only path for "download the PDF." A blob: URL (what Electron/
 * desktop uses via URL.createObjectURL - see lib/api.ts's fetchPdf and
 * NotesApp.tsx) produces no visible save/open behavior when tapped inside
 * Android's WebView - there's no download manager wired up to blob:
 * navigation the way a real browser tab has, so the tap just silently did
 * nothing. This was the actual bug report.
 *
 * Instead: write the bytes to real on-device storage via
 * @capacitor/filesystem (Directory.Cache - staging for the share step
 * below, not meant to be the final resting place; Android's scoped storage
 * means an app-private directory like this isn't independently browsable
 * by the user anyway, hence handing off to Share immediately), then open
 * the system Share sheet via @capacitor/share so the user can save it to
 * Downloads, open it in a PDF viewer, send it elsewhere - whatever
 * "do something with this file" means on their phone. This is the
 * standard Capacitor recipe for exactly this problem, not a novel
 * approach invented here.
 *
 * Always resolves to a result the caller can show, never throws - the
 * original complaint was a failed action giving zero feedback, so every
 * branch here (including the user just cancelling the share sheet, which
 * isn't really a failure) needs to land on something visible.
 */
export async function savePdfOnMobile(blob: Blob, filename: string): Promise<SavePdfResult> {
  try {
    const base64 = await blobToBase64(blob);

    const written = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Cache,
    });

    try {
      await Share.share({ title: filename, url: written.uri });
      return { status: "shared" };
    } catch (shareErr) {
      // The file is safely written even if the user backs out of the share
      // sheet (or a share target rejects it) - that's a real, visible
      // outcome worth reporting as such, not a failure.
      if (isUserCancelled(shareErr)) return { status: "saved", path: written.uri };
      throw shareErr;
    }
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Couldn't save the PDF to this device.",
    };
  }
}
