import { appendFile, mkdir, open, readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { errorCode } from "../fsutil.js";
import { withLock } from "../lock.js";
import { assertSafePath } from "../paths.js";
import { authorDir, BUS_NAME_RE, isEnvelope, type Envelope } from "./envelope.js";
import type { BusTransport, Cursor } from "./transport.js";

// ─── Filesystem transport (phase 1) ──────────────────────────────────────────
//
//   <busRoot>/log/<author>/000001.jsonl   append-only, written only by that repo
//   <busRoot>/log/<author>/body/<id>.md   immutable bodies (exclusive create)
//   <busRoot>/log/<author>/.lock
//
// One writer per file: Windows and WSL processes never append to the same
// log, and a late writer can't slip behind a reader's cursor because each
// cursor is a per-author byte offset into a file that only grows.

const SEGMENT_MAX_BYTES = 1024 * 1024;
const SEGMENT_RE = /^(\d{6})\.jsonl$/;

type Position = { seg: number; off: number };
type CursorMap = Record<string, Position>;

const segName = (n: number) => `${String(n).padStart(6, "0")}.jsonl`;

function decodeCursor(c: Cursor | null): CursorMap {
  if (!c) return {};
  try {
    const parsed = JSON.parse(c);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function listSegments(dir: string): Promise<number[]> {
  try {
    return (await readdir(dir))
      .map((n) => n.match(SEGMENT_RE))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Bytes of `file` from `off` up to the last complete line. */
async function readCompleteLines(file: string, off: number): Promise<{ text: string; end: number }> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size <= off) return { text: "", end: off };
    const buf = Buffer.alloc(size - off);
    await fh.read(buf, 0, buf.length, off);
    const last = buf.lastIndexOf(0x0a);
    // A trailing partial line may still be mid-append: leave it for next time
    if (last === -1) return { text: "", end: off };
    return { text: buf.subarray(0, last + 1).toString("utf-8"), end: off + last + 1 };
  } finally {
    await fh.close();
  }
}

export class FsTransport implements BusTransport {
  constructor(private readonly busRoot: string) {}

  private logRoot(): string {
    return join(this.busRoot, "log");
  }

  private authorPath(repo: string): string {
    if (!BUS_NAME_RE.test(repo)) {
      throw new Error(`Repo name "${repo}" can't be used on the bus — use letters, digits, ".", "_" and "-"`);
    }
    const dir = join(this.logRoot(), authorDir(repo));
    assertSafePath(dir, [this.logRoot()]);
    return dir;
  }

  async append(envelope: Envelope, body?: string): Promise<void> {
    const dir = this.authorPath(envelope.from.repo);
    if (body !== undefined) {
      await mkdir(join(dir, "body"), { recursive: true });
      // Never renamed or modified, so no drvfs rename errors. A crash before
      // the append below leaves an orphan body, which is harmless.
      await writeExclusive(join(dir, "body", `${envelope.id}.md`), body);
    }
    await withLock(join(dir, ".lock"), async () => {
      const segs = await listSegments(dir);
      let head = segs.at(-1) ?? 1;
      const size = await stat(join(dir, segName(head))).then((s) => s.size, () => 0);
      if (size >= SEGMENT_MAX_BYTES) head += 1;
      // The append is the commit point
      await appendFile(join(dir, segName(head)), JSON.stringify(envelope) + "\n", "utf-8");
    });
  }

  async read(from: Cursor | null): Promise<{ items: Envelope[]; next: Cursor }> {
    const cursor = decodeCursor(from);
    const next: CursorMap = { ...cursor };
    const items: Envelope[] = [];
    let authors: string[];
    try {
      authors = (await readdir(this.logRoot(), { withFileTypes: true }))
        .filter((e) => e.isDirectory() && BUS_NAME_RE.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return { items, next: JSON.stringify(next) };
    }
    for (const author of authors) {
      const dir = join(this.logRoot(), author);
      const pos = cursor[author] ?? { seg: 0, off: 0 };
      for (const seg of await listSegments(dir)) {
        if (seg < pos.seg) continue;
        const start = seg === pos.seg ? pos.off : 0;
        const { text, end } = await readCompleteLines(join(dir, segName(seg)), start);
        next[author] = { seg, off: end };
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const env = JSON.parse(line);
            // An author directory only holds that author's envelopes
            if (isEnvelope(env) && authorDir(env.from.repo) === author) items.push(env);
          } catch {
            // skip malformed lines
          }
        }
      }
    }
    return { items, next: JSON.stringify(next) };
  }

  async body(author: string, id: string): Promise<string | null> {
    if (!/^[mr]-[0-9a-z]+$/.test(id)) return null;
    try {
      return await readFile(join(this.authorPath(author), "body", `${id}.md`), "utf-8");
    } catch {
      return null;
    }
  }
}

async function writeExclusive(file: string, data: string): Promise<void> {
  try {
    const fh = await open(file, "wx");
    try {
      await fh.writeFile(data, "utf-8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (errorCode(err) === "EEXIST") throw new Error(`Message body ${file} already exists`);
    throw err;
  }
}
