import { getStoredValue, setStoredValue } from "./localKV";
import type { RecentActivity } from "@/components/AppShell";

const HISTORY_KEY = "notesify.sessionHistory.v1";

// How many past generations Home's list keeps around - oldest entries
// fall off once a new one pushes past this. AppShell owns the actual
// list (in-memory `recentActivity` state); this is just the storage cap,
// kept here since "how much history is worth persisting" is a storage
// concern, not a UI one.
export const MAX_HISTORY_ENTRIES = 10;

// Loose structural check rather than a strict schema validator - this
// only needs to catch "not shaped like a RecentActivity at all" (a wiped/
// corrupted store, or a future incompatible schema version), not validate
// every field precisely. A malformed single entry is dropped rather than
// discarding the whole list.
function isRecentActivity(value: unknown): value is RecentActivity {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.jobId === "string" &&
    typeof v.title === "string" &&
    typeof v.completedAt === "number" &&
    Array.isArray(v.sourceUrls) &&
    typeof v.filename === "string" &&
    (v.localPdfPath === null || typeof v.localPdfPath === "string")
  );
}

/**
 * Loads the persisted history index - the small metadata (title, source
 * URL(s), timestamp, and a reference to the actual PDF already persisted
 * on-device via lib/pdfStore.ts) that lets Home's list survive an app
 * restart, not just the current in-memory session. Never throws - missing
 * or corrupt storage (or a single malformed entry within otherwise-valid
 * storage) just yields fewer/no entries, same as a first-ever launch.
 */
export async function loadSessionHistory(): Promise<RecentActivity[]> {
  const raw = await getStoredValue(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentActivity).slice(0, MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

/** Persists the current history list whole (it's small metadata, not the PDFs themselves) - callers pass the already-capped list they want stored. */
export async function saveSessionHistory(items: RecentActivity[]): Promise<void> {
  await setStoredValue(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY_ENTRIES)));
}
