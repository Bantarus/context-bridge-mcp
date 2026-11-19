import { readFile, appendFile, mkdir } from "fs/promises";
import { cfg } from "./config.js";
import type { ChangelogEntry } from "./types.js";

// ─── Changelog (changelog.jsonl) ─────────────────────────────────────────────
//
// The shared, append-only log of bridge-generated events: context, contract,
// manifest and skill changes. Messages used to be logged here too; they now
// live on the bus, and old `type: "message"` lines are read as legacy mail.

export type ChangelogLine = ChangelogEntry & { line: number };

export async function appendChangelog(entry: ChangelogEntry): Promise<void> {
  await mkdir(cfg().ecosystemRoot, { recursive: true });
  await appendFile(cfg().changelogPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Read the changelog. Each entry carries its line index so callers can use a
 * position cursor instead of timestamps: entries are written by processes on
 * different clocks (a WSL2 VM clock can lag the Windows host after sleep),
 * so "timestamp > lastCheckedAt" can skip entries. `lineCount` counts only
 * complete lines — a trailing partial line may still be mid-append.
 */
export async function readChangelog(): Promise<{
  entries: ChangelogLine[];
  lineCount: number;
}> {
  let raw: string;
  try {
    raw = await readFile(cfg().changelogPath, "utf-8");
  } catch {
    return { entries: [], lineCount: 0 };
  }
  const lines = raw.split("\n");
  const lineCount = lines.length - 1;
  const entries: ChangelogLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (!lines[i].trim()) continue;
    try {
      entries.push({ ...JSON.parse(lines[i]), line: i });
    } catch {
      // skip malformed lines
    }
  }
  return { entries, lineCount };
}

/** Version an entry published. Older entries only state it in the summary. */
export function entryVersion(e: ChangelogEntry): string | null {
  if (e.version) return e.version;
  if (e.type === "skill") {
    const m = e.summary.match(/^published (\S+)$/) ?? e.summary.match(/-> (\S+)$/);
    if (m && m[1] !== "(unversioned)") return m[1];
  }
  return null;
}

/**
 * The version `repo` last logged for a skill or contract, or null when it
 * never logged one (or last unpublished it).
 */
export async function lastLoggedVersion(
  repo: string,
  type: "skill" | "contract",
  domain: string
): Promise<string | null> {
  const { entries } = await readChangelog();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.repo !== repo || e.type !== type || e.domain !== domain) continue;
    if (e.summary === "unpublished") return null;
    const v = entryVersion(e);
    if (v) return v;
  }
  return null;
}

/**
 * Watch tokens map to either a specific domain name (e.g. "users" → entries
 * whose `domain === "users"`), or a category keyword that maps to one of the
 * stored type values. Categories accept both the singular type name and the
 * conventional plural the README example uses ("contracts" → type "contract").
 * Match is case-insensitive on the category keyword; domain match is strict.
 */
export const WATCH_CATEGORY_ALIASES: Record<string, ChangelogEntry["type"]> = {
  contract: "contract",
  contracts: "contract",
  context: "context",
  manifest: "manifest",
  manifests: "manifest",
  skill: "skill",
  skills: "skill",
  message: "message",
  messages: "message",
};

export function watchMatchesEntry(
  watchList: string[],
  entry: ChangelogEntry
): boolean {
  for (const w of watchList) {
    // Exact domain match — e.g. "users" matches a contract or context with domain "users"
    if (w === entry.domain) return true;
    // Category match — both singular ("contract") and plural ("contracts") supported
    const alias = WATCH_CATEGORY_ALIASES[w.toLowerCase()];
    if (alias && alias === entry.type) return true;
  }
  return false;
}
