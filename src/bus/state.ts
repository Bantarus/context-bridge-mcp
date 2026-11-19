import { join } from "path";
import { internalError } from "../errors.js";
import { readJsonFile, writeFileAtomic } from "../fsutil.js";
import { withLock } from "../lock.js";
import { authorDir, type Intent, type ItemState, type Priority, type ReceiptState, type Via } from "./envelope.js";
import type { Cursor } from "./transport.js";

// ─── Per-repo state ──────────────────────────────────────────────────────────
//
// `<busRoot>/state/<repo>.json` holds one repo's read position, inbox, sent
// items and feed. Only that repo's bridge sessions and CLI invocations write
// it, always under `<repo>.lock`, re-reading inside the lock.

interface ItemBase {
  id: string;
  from: string;
  subject: string;
  lc: number;
  ts: string;
  /** Sending session and how it sent (tool, cli); absent for legacy mail. */
  session?: string;
  via?: Via;
}

export interface InboxItem extends ItemBase {
  to: string[];
  intent: Intent;
  priority: Priority;
  thread: string;
  replyTo?: string;
  expiresAt?: string;
  template?: string;
  state: ItemState;
  /** Session that last changed the state. */
  by?: string;
  note?: string;
  /** Old-style message: body is `<from>/.context/<domain>/<component>.md`. */
  legacy?: { domain: string; component: string };
}

export interface SentItem extends ItemBase {
  to?: string[];
  topic?: string;
  intent: Intent;
  priority: Priority;
  thread: string;
  replyTo?: string;
  /** Per recipient, from their receipts and replies. */
  status: Record<string, { state: ReceiptState; by?: string; note?: string; ts: string }>;
}

export interface FeedItem extends ItemBase {
  topic: string;
  thread: string;
  replyTo?: string;
  seen: boolean;
}

export interface RepoState {
  v: 1;
  cursor: Cursor | null;
  lc: number;
  inbox: Record<string, InboxItem>;
  sent: Record<string, SentItem>;
  feed: FeedItem[];
  /** Recent sends, for duplicate suppression and the store ceiling. */
  recent: Array<{ hash: string; at: number }>;
}

export const FEED_KEEP = 200;

export function emptyState(): RepoState {
  return { v: 1, cursor: null, lc: 0, inbox: {}, sent: {}, feed: [], recent: [] };
}

export class StateStore {
  constructor(private readonly busRoot: string) {}

  private paths(repo: string) {
    const base = join(this.busRoot, "state", authorDir(repo));
    return { file: `${base}.json`, lock: `${base}.lock` };
  }

  async read(repo: string): Promise<RepoState> {
    const { file } = this.paths(repo);
    const parsed = await readJsonFile<Partial<RepoState>>(file, () =>
      internalError(`Bus state for "${repo}" is malformed — fix or delete state/${authorDir(repo)}.json`)
    );
    return { ...emptyState(), ...parsed };
  }

  /** Re-read under the repo's lock, apply `mutate`, write back. */
  async update<T>(repo: string, mutate: (s: RepoState) => Promise<T> | T): Promise<T> {
    const { file, lock } = this.paths(repo);
    return withLock(lock, async () => {
      const state = await this.read(repo);
      const result = await mutate(state);
      await writeFileAtomic(file, JSON.stringify(state, null, 2));
      return result;
    });
  }
}
