import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withLock } from "../../src/lock.js";

describe("withLock", () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-lock-"));
    lock = join(dir, "x.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serialises critical sections", async () => {
    let inside = 0;
    let maxInside = 0;
    const work = () =>
      withLock(lock, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 5));
        inside--;
      });
    await Promise.all(Array.from({ length: 8 }, work));
    expect(maxInside).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("lets only one waiter break a stale lock (G9)", async () => {
    writeFileSync(lock, "dead-process");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    let inside = 0;
    let maxInside = 0;
    const work = () =>
      withLock(lock, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 10));
        inside--;
      });
    await Promise.all(Array.from({ length: 6 }, work));
    expect(maxInside).toBe(1);
  });

  it("does not remove a lock it no longer holds", async () => {
    await withLock(lock, async () => {
      // Someone broke our lock while we overran and took it themselves
      writeFileSync(lock, "someone-else");
    });
    expect(existsSync(lock)).toBe(true);
  });
});
