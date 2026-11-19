import { mkdir } from "fs/promises";
import { join } from "path";
import { readJsonFile, writeFileAtomic } from "../fsutil.js";
import { objectField, stringArrayField } from "../manifest.js";
import type { Manifest } from "../types.js";
import { authorDir } from "./envelope.js";
import { declaredTopics, type TopicDecl } from "./topics.js";

// ─── Directory ───────────────────────────────────────────────────────────────
//
// `<busRoot>/directory/<repo>.json`: what a repo declares about itself on the
// bus — its topics and who may message it — copied from its manifest by its
// own sessions. Other repos read this instead of the owner's manifest, which
// may live in an environment they can't reach (and whose path they must
// never learn).

export interface Messaging {
  accept?: string[];
  block?: string[];
}

export interface DirectoryEntry {
  topics: Record<string, TopicDecl>;
  messaging: Messaging;
}

export function directoryEntryOf(manifest: Manifest): DirectoryEntry {
  const m = objectField(manifest, "messaging");
  const messaging: Messaging = {};
  if (Array.isArray(m.accept)) messaging.accept = stringArrayField(m, "accept");
  if (Array.isArray(m.block)) messaging.block = stringArrayField(m, "block");
  return { topics: declaredTopics(manifest), messaging };
}

/** Whether `rules` let `sender` message their owner. */
export function accepts(rules: Messaging, sender: string): boolean {
  if (rules.block?.includes(sender)) return false;
  return !rules.accept || rules.accept.includes(sender);
}

export class Directory {
  constructor(private readonly busRoot: string) {}

  private file(repo: string): string {
    return join(this.busRoot, "directory", `${authorDir(repo)}.json`);
  }

  async get(repo: string): Promise<DirectoryEntry | null> {
    // A broken entry reads as "declares nothing" rather than failing the call
    return readJsonFile<DirectoryEntry>(this.file(repo), () => new Error("malformed")).catch(() => null);
  }

  /** Publish this repo's entry; skips the write when nothing changed. */
  async publish(repo: string, entry: DirectoryEntry): Promise<void> {
    const next = JSON.stringify(entry, null, 2);
    const current = await this.get(repo);
    if (current && JSON.stringify(current, null, 2) === next) return;
    await mkdir(join(this.busRoot, "directory"), { recursive: true });
    await writeFileAtomic(this.file(repo), next);
  }
}
