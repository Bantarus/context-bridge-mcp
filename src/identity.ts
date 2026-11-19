import { ownRepoRoot } from "./config.js";
import { findRepoByPath, readEcosystem } from "./ecosystem.js";
import { currentRepoName } from "./manifest.js";
import type { Ecosystem } from "./types.js";

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * A warning when this repo isn't usable by others: not in the ecosystem, or
 * registered under a name other than the one its changelog entries use.
 * Null when all is well (or the ecosystem can't be read).
 */
export async function registrationNotice(): Promise<string | null> {
  let eco: Ecosystem;
  try {
    eco = await readEcosystem();
  } catch {
    return null;
  }
  const name = await currentRepoName();
  if (eco.repos[name]) return null;
  const own = ownRepoRoot();
  const byPath = findRepoByPath(eco, own);
  if (byPath) {
    return (
      `⚠ This repo is registered in the ecosystem as "${byPath}", but its manifest calls it "${name}". ` +
      `Its changelog entries are signed "${name}", so other repos can't link them to it. ` +
      `Set "project": "${byPath}" with bridge_manifest_update.`
    );
  }
  return (
    `⚠ This repo ("${name}") is not registered in the ecosystem: other repos can't discover it, read its ` +
    "contracts or skills, or exchange messages with it. To expose it, ask the user which domains other " +
    `repos may read, then: bridge_register({ name: "${name}", path: "${own.replace(/\\/g, "\\\\")}", exposes: [...] })`
  );
}
