import { mkdir, open, readFile, stat, rm, rename } from "fs/promises";
import { basename, dirname } from "path";
import { randomBytes } from "crypto";
import { errorCode, sleep } from "./fsutil.js";
import { internalError } from "./errors.js";

// ─── Cross-process lock ──────────────────────────────────────────────────────
//
// An O_EXCL lock file, which works on ext4, drvfs (/mnt/c) and NTFS alike, so
// bridge processes in Windows and in several WSL distros can share one folder
// without losing each other's updates.

const LOCK_TIMEOUT_MS = 5_000;
// Generous: lock mtime comes from the filesystem server (Windows for /mnt/c),
// whose clock can disagree with a WSL2 VM clock.
const LOCK_STALE_MS = 30_000;

async function tryCreate(path: string, token: string): Promise<boolean> {
  try {
    const fh = await open(path, "wx");
    await fh.writeFile(token);
    await fh.close();
    return true;
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
    return false;
  }
}

async function isStale(path: string): Promise<boolean | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return null;  // vanished
  }
}

/**
 * Break a stale lock. Only the holder of `<lock>.break` may do it, and it
 * re-checks staleness while holding that, so two waiters can't both break
 * the same lock — the second would otherwise delete the first one's fresh
 * lock. The breaker renames before deleting so the removal is one step.
 */
async function breakStaleLock(path: string, token: string): Promise<void> {
  const breaker = `${path}.break`;
  if (!(await tryCreate(breaker, token))) {
    // A dead breaker must not block everyone forever
    if (await isStale(breaker)) {
      const grave = `${breaker}.${token}.stale`;
      await rename(breaker, grave).then(() => rm(grave, { force: true }), () => {});
    }
    return;
  }
  try {
    if (await isStale(path)) {
      const grave = `${path}.${token}.stale`;
      await rename(path, grave).then(() => rm(grave, { force: true }), () => {});
    }
  } finally {
    await rm(breaker, { force: true }).catch(() => {});
  }
}

/** Run `fn` while holding the lock file at `path`. */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!(await tryCreate(path, token))) {
    const stale = await isStale(path);
    if (stale === null) continue;  // lock vanished between open and stat — retry immediately
    if (stale) {
      await breakStaleLock(path, token);
      continue;
    }
    if (Date.now() > deadline) {
      throw internalError(
        `Timed out waiting for ${basename(path)} — delete it if no other bridge process is running`
      );
    }
    await sleep(20 + Math.random() * 30);
  }
  try {
    return await fn();
  } finally {
    // Only remove our own lock: if we overran the stale timeout, another
    // process may hold it now
    const held = await readFile(path, "utf-8").catch(() => null);
    if (held === token) await rm(path, { force: true }).catch(() => {});
  }
}
