/**
 * Build a minimal "other repo" on disk for cross-repo tests. No bridge
 * server is spawned for the mock — it's just a tmp directory with the file
 * layout the bridge expects (a .context/ folder with whatever files the
 * test wants to expose).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export interface MockRepo {
  path: string;
  /** Write or overwrite a file relative to the repo root. */
  writeFile: (relPath: string, content: string) => void;
  /** Delete the tmp directory. */
  cleanup: () => void;
}

export function makeMockRepo(
  prefix: string,
  files: Record<string, string> = {}
): MockRepo {
  const path = mkdtempSync(join(tmpdir(), `bridge-mock-${prefix}-`));
  const writeFile = (relPath: string, content: string) => {
    const full = join(path, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  };
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(relPath, content);
  }
  return {
    path,
    writeFile,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
