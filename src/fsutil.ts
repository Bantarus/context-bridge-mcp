import { readFile, writeFile, readdir, rename, rm } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

// ─── Filesystem helpers ──────────────────────────────────────────────────────

export function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RENAME_RETRIES = 6;
const RENAME_BACKOFF_MS = 15;

export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  // Write to a sibling temp file then rename — rename is atomic so readers
  // never see a torn file, and a crash mid-write leaves the original intact.
  // The 4-byte random suffix prevents collisions when multiple atomic writes
  // to the same target happen within a single millisecond from the same pid
  // (e.g. Promise.all([writeFileAtomic(p, a), writeFileAtomic(p, b)])).
  //
  // On Windows (and on /mnt/c from WSL) rename-over-existing fails with
  // EPERM/EBUSY/EACCES while another process — antivirus, indexer, a reader
  // in another environment — holds the target open, so retry with backoff.
  const tmp = `${target}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, typeof data === "string" ? "utf-8" : undefined);
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, target);
        return;
      } catch (err) {
        const code = errorCode(err);
        const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!retryable || attempt >= RENAME_RETRIES) throw err;
        await sleep(RENAME_BACKOFF_MS * 2 ** attempt);
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Parse a JSON file; null when missing, `onMalformed()` when unparseable. */
export async function readJsonFile<T>(path: string, onMalformed: () => Error): Promise<T | null> {
  const raw = await safeRead(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw onMalformed();
  }
}

export async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) {
        results.push(e.name.replace(/\.md$/, ""));
      } else if (e.isDirectory()) {
        const nested = await listMdFiles(join(dir, e.name));
        results.push(...nested.map((n) => `${e.name}/${n}`));
      }
    }
    return results;
  } catch {
    return [];
  }
}

/** Relative paths of regular files under `root`. Symlinks are skipped. */
export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const sub = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), sub);
      } else if (e.isFile()) {
        out.push(sub);
      }
    }
  }
  await walk(root, "");
  return out;
}
