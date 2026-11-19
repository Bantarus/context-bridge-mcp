import { readFile } from "fs/promises";
import { join } from "path";
import { cfg } from "./config.js";
import { internalError } from "./errors.js";
import { writeFileAtomic } from "./fsutil.js";
import { withLock } from "./lock.js";
import type { Manifest } from "./types.js";

// ─── Manifest ────────────────────────────────────────────────────────────────

export async function readManifest(): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(cfg().manifestPath, "utf-8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw internalError("manifest.json is malformed — fix or delete the file to re-initialize");
  }
}

export async function writeManifest(data: Manifest): Promise<void> {
  await writeFileAtomic(cfg().manifestPath, JSON.stringify(data, null, 2));
}

/**
 * Re-read the manifest under a lock, apply `mutate`, write it back. Two
 * sessions (or a session and the CLI) in one repo then can't lose each
 * other's edit. `mutate` may return false to skip the write.
 */
export async function updateManifest(
  mutate: (m: Manifest) => boolean | void
): Promise<Manifest> {
  return withLock(join(cfg().contextRoot, ".manifest.lock"), async () => {
    const manifest = await readManifest();
    if (mutate(manifest) !== false) await writeManifest(manifest);
    return manifest;
  });
}

export async function currentRepoName(): Promise<string> {
  const manifest = await readManifest();
  if (typeof manifest.project === "string" && manifest.project) {
    return manifest.project;
  }
  // Fallback: directory name of CWD
  return cfg().cwd.split(/[\\/]/).pop() ?? "unknown";
}

/** A plain-object field of the manifest, or {} when absent or of another shape. */
export function objectField<T = unknown>(m: Manifest, key: string): Record<string, T> {
  const v = m[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

/** A string-array field of the manifest, or [] when absent or of another shape. */
export function stringArrayField(m: Manifest, key: string): string[] {
  const v = m[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
