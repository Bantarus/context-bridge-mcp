import { readFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { cfg } from "./config.js";
import { internalError } from "./errors.js";
import { safeRead, writeFileAtomic } from "./fsutil.js";
import { withLock } from "./lock.js";
import { assertSafePath, resolveStoredDir, toLocalPath, type LocalPathResult } from "./paths.js";
import type { Ecosystem, EcosystemEntry } from "./types.js";

// ─── Ecosystem registry ──────────────────────────────────────────────────────

export async function readEcosystem(): Promise<Ecosystem> {
  let raw: string;
  try {
    raw = await readFile(cfg().ecosystemPath, "utf-8");
  } catch {
    return { version: "1.0", repos: {} };
  }
  // A malformed file must not be treated as empty: the next write would
  // silently wipe every registration.
  try {
    const parsed = JSON.parse(raw);
    parsed.repos ??= {};
    return parsed;
  } catch {
    throw internalError("ecosystem.json in ECOSYSTEM_ROOT is malformed — fix or delete the file");
  }
}

async function writeEcosystem(data: Ecosystem): Promise<void> {
  await mkdir(cfg().ecosystemRoot, { recursive: true });
  await writeFileAtomic(cfg().ecosystemPath, JSON.stringify(data, null, 2));
}

/**
 * Re-read ecosystem.json under the lock, apply `mutate`, and write it back.
 * Always use this for writes — never write a snapshot read earlier, or
 * concurrent registrations/pins from other sessions get clobbered.
 * `mutate` may return false to skip the write.
 */
export async function updateEcosystem(
  mutate: (eco: Ecosystem) => boolean | void
): Promise<void> {
  await withLock(cfg().ecosystemLockPath, async () => {
    const eco = await readEcosystem();
    if (mutate(eco) === false) return;
    await writeEcosystem(eco);
  });
}

/** The registered name whose stored path is `dir` in this environment, if any. */
export function findRepoByPath(eco: Ecosystem, dir: string): string | null {
  const target = resolve(dir);
  const hit = Object.entries(eco.repos).find(([, e]) => {
    const local = toLocalPath(e.path);
    return "path" in local && resolve(local.path) === target;
  });
  return hit ? hit[0] : null;
}

export function repoRoot(name: string, entry: EcosystemEntry): LocalPathResult {
  return resolveStoredDir(entry.path, `repo "${name}"`);
}

export function repoContractsDir(name: string, entry: EcosystemEntry): LocalPathResult {
  if (entry.contractsPath) {
    return resolveStoredDir(entry.contractsPath, `contracts of "${name}"`);
  }
  const root = repoRoot(name, entry);
  return "error" in root ? root : { path: join(root.path, ".context", "contracts") };
}

/** Read `<domain>.md` from another repo's contracts directory. */
export async function readRepoContract(
  name: string,
  entry: EcosystemEntry,
  domain: string
): Promise<{ content: string | null } | { error: string }> {
  const dir = repoContractsDir(name, entry);
  if ("error" in dir) return dir;
  const file = join(dir.path, `${domain}.md`);
  assertSafePath(file, [dir.path]);
  return { content: await safeRead(file) };
}
