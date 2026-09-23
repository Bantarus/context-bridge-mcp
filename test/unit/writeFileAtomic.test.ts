import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "../../src/index.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a file that did not exist", async () => {
    const target = join(dir, "new.json");
    await writeFileAtomic(target, '{"hello":"world"}');
    expect(readFileSync(target, "utf-8")).toBe('{"hello":"world"}');
  });

  it("overwrites an existing file", async () => {
    const target = join(dir, "existing.txt");
    writeFileSync(target, "old", "utf-8");
    await writeFileAtomic(target, "new");
    expect(readFileSync(target, "utf-8")).toBe("new");
  });

  it("writes an empty string correctly", async () => {
    const target = join(dir, "empty.txt");
    await writeFileAtomic(target, "");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("");
  });

  it("leaves no .tmp file behind after a successful write", async () => {
    const target = join(dir, "clean.json");
    await writeFileAtomic(target, "{}");
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(remaining).toEqual([]);
  });

  it("preserves the original file when the target path is invalid", async () => {
    // Writing to a path inside a non-existent directory should fail without
    // touching anything else. The temp file write happens before rename, so a
    // failure mid-rename can't corrupt an existing target — but a write
    // failure (bad parent dir) propagates as a thrown error.
    const target = join(dir, "missing-subdir", "file.txt");
    await expect(writeFileAtomic(target, "data")).rejects.toThrow();
  });

  it("removes its temp file when the rename fails", async () => {
    // Renaming a file over a non-empty directory fails with a non-retryable error
    const target = join(dir, "occupied");
    mkdirSync(join(target, "child"), { recursive: true });
    await expect(writeFileAtomic(target, "data")).rejects.toThrow();
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(remaining).toEqual([]);
  });
});
