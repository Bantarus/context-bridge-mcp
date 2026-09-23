import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readFile, writeFile, appendFile, readdir, mkdir, rename, open, stat, rm } from "fs/promises";
import { join, resolve, relative, isAbsolute, sep, posix, win32 } from "path";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONTEXT_ROOT = resolve(
  process.env.CONTEXT_ROOT ?? join(process.cwd(), ".context")
);

const CONTRACTS_ROOT = resolve(
  process.env.CONTRACTS_ROOT ?? join(CONTEXT_ROOT, "contracts")
);

const MANIFEST_PATH = join(CONTEXT_ROOT, "manifest.json");

const ECOSYSTEM_ROOT = resolve(
  process.env.ECOSYSTEM_ROOT ?? join(homedir(), ".context-bridge")
);

const ECOSYSTEM_PATH = join(ECOSYSTEM_ROOT, "ecosystem.json");

const CHANGELOG_PATH = join(ECOSYSTEM_ROOT, "changelog.jsonl");

const ECOSYSTEM_LOCK_PATH = join(ECOSYSTEM_ROOT, "ecosystem.lock");

// Skills shipped with this MCP server (relative to compiled dist/index.js)
const SKILLS_SOURCE = resolve(import.meta.dirname, "..", ".claude", "skills");
const BRIDGE_SKILLS = ["context-reader", "context-feeder", "context-bridge"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConsumedVersion {
  version: string;
  source: string;       // which repo the contract was read from
  consumedAt: string;   // ISO timestamp of when it was read
}

interface EcosystemEntry {
  path: string;            // canonical form — see toCanonicalPath()
  contractsPath?: string;  // canonical; only set when contracts live outside <path>/.context/contracts
  exposes: string[];
  stack?: string;
  registeredAt: string;
  lastCheckedAt?: string;
  changelogCursor?: number;  // number of complete changelog.jsonl lines already seen
  consumedVersions?: Record<string, ConsumedVersion>;  // keyed by contract domain
}

interface Ecosystem {
  version: string;
  repos: Record<string, EcosystemEntry>;
}

interface ChangelogEntry {
  timestamp: string;
  repo: string;
  type: "context" | "contract" | "manifest";
  domain: string;
  component: string | null;
  summary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readEcosystem(): Promise<Ecosystem> {
  let raw: string;
  try {
    raw = await readFile(ECOSYSTEM_PATH, "utf-8");
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
    throw new McpError(
      ErrorCode.InternalError,
      `ecosystem.json is malformed (${ECOSYSTEM_PATH}) — fix or delete the file`
    );
  }
}

async function writeEcosystem(data: Ecosystem): Promise<void> {
  await mkdir(ECOSYSTEM_ROOT, { recursive: true });
  await writeFileAtomic(ECOSYSTEM_PATH, JSON.stringify(data, null, 2));
}

const LOCK_TIMEOUT_MS = 5_000;
// Generous: lock mtime comes from the filesystem server (Windows for /mnt/c),
// whose clock can disagree with a WSL2 VM clock.
const LOCK_STALE_MS = 30_000;

/**
 * Cross-process mutex around ecosystem.json read-modify-write cycles. Uses an
 * O_EXCL lock file, which works on ext4, drvfs (/mnt/c) and NTFS alike, so
 * bridge processes in Windows and in several WSL distros can share one
 * ECOSYSTEM_ROOT without losing each other's updates.
 */
async function withEcosystemLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(ECOSYSTEM_ROOT, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(ECOSYSTEM_LOCK_PATH, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      try {
        const st = await stat(ECOSYSTEM_LOCK_PATH);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(ECOSYSTEM_LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        continue;  // lock vanished between open and stat — retry immediately
      }
      if (Date.now() > deadline) {
        throw new McpError(
          ErrorCode.InternalError,
          `Timed out waiting for ${ECOSYSTEM_LOCK_PATH} — delete it if no other bridge process is running`
        );
      }
      await sleep(20 + Math.random() * 30);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(ECOSYSTEM_LOCK_PATH, { force: true }).catch(() => {});
  }
}

/**
 * Re-read ecosystem.json under the lock, apply `mutate`, and write it back.
 * Always use this for writes — never write a snapshot read earlier, or
 * concurrent registrations/pins from other sessions get clobbered.
 * `mutate` may return false to skip the write.
 */
async function updateEcosystem(
  mutate: (eco: Ecosystem) => boolean | void
): Promise<void> {
  await withEcosystemLock(async () => {
    const eco = await readEcosystem();
    if (mutate(eco) === false) return;
    await writeEcosystem(eco);
  });
}

async function readManifest(): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, "utf-8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      "manifest.json is malformed — fix or delete the file to re-initialize"
    );
  }
}

async function writeManifest(data: Record<string, unknown>): Promise<void> {
  await writeFileAtomic(MANIFEST_PATH, JSON.stringify(data, null, 2));
}

function contextPath(
  root: string,
  domain: string,
  component?: string
): string {
  const base = join(root, domain);
  return component ? join(base, `${component}.md`) : base;
}

function contractPath(domain: string): string {
  return join(CONTRACTS_ROOT, `${domain}.md`);
}

export async function writeFileAtomic(target: string, data: string): Promise<void> {
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
    await writeFile(tmp, data, "utf-8");
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

const RENAME_RETRIES = 6;
const RENAME_BACKOFF_MS = 15;

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function listMdFiles(dir: string): Promise<string[]> {
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

/**
 * Throw if `resolvedPath` is not inside any of `allowedRoots`.
 *
 * WARNING: this is a string-based check via `path.relative` — it does NOT
 * follow symlinks. If a symlink inside an allowed root points outside,
 * filesystem access via the resolved path will escape even though this
 * function passes. The bridge mitigates by owning its own roots and never
 * creating symlinks; consumers of this function as a library MUST realpath
 * their inputs first if untrusted symlinks may exist.
 */
export function assertSafePath(resolvedPath: string, allowedRoots: string[]): void {
  const safe = allowedRoots.some((root) => {
    const rel = relative(root, resolvedPath);
    // `rel` is absolute when the path is on another Windows drive; a bare
    // startsWith("..") check would also wrongly reject names like "..notes".
    return (
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel)
    );
  });
  if (!safe) {
    throw new McpError(ErrorCode.InvalidParams, "Path escapes allowed roots");
  }
}

// ─── Cross-environment paths (Windows ↔ WSL ↔ WSL) ───────────────────────────
//
// ecosystem.json may be shared by bridge processes running on Windows and in
// several WSL distros, each of which sees the filesystem differently. Paths
// are therefore stored in the one namespace that can address all of them —
// the Windows view (`C:\...`, `\\wsl.localhost\<Distro>\...`) — and each
// process translates to its own view when reading. On plain Linux/macOS
// (no WSL) paths are stored as ordinary POSIX paths.

export interface PathEnv {
  platform: string;
  /** WSL distro this process runs in (WSL_DISTRO_NAME), if any. */
  wslDistro?: string;
  /** Where Windows drives are mounted inside WSL (wsl.conf automount root). */
  wslDrivesRoot: string;
  /** Where other distros' root filesystems are bind-mounted inside WSL. */
  wslDistrosRoot: string;
}

export function currentPathEnv(): PathEnv {
  return {
    platform: process.platform,
    wslDistro:
      process.platform === "win32" ? undefined : process.env.WSL_DISTRO_NAME || undefined,
    wslDrivesRoot: posix.resolve(process.env.WSL_DRIVES_ROOT ?? "/mnt"),
    wslDistrosRoot: posix.resolve(process.env.WSL_DISTROS_ROOT ?? "/mnt/wsl"),
  };
}

type ParsedPath =
  | { kind: "drive"; drive: string; segs: string[] }
  | { kind: "wsl"; distro: string; segs: string[] }
  | { kind: "unc"; raw: string }
  | { kind: "posix"; segs: string[] };

function toSegments(rest: string): string[] {
  const out: string[] = [];
  for (const s of rest.split(/[\\/]+/)) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out;
}

/** Parse an absolute path in any of the supported notations; null if relative. */
export function parseAnyPath(p: string): ParsedPath | null {
  const drive = p.match(/^([A-Za-z]):(?:[\\/](.*))?$/s);
  if (drive) {
    return { kind: "drive", drive: drive[1].toUpperCase(), segs: toSegments(drive[2] ?? "") };
  }
  const wsl = p.match(/^[\\/]{2}wsl(?:\$|\.localhost)[\\/]+([^\\/]+)(?:[\\/](.*))?$/is);
  if (wsl) return { kind: "wsl", distro: wsl[1], segs: toSegments(wsl[2] ?? "") };
  if (/^[\\/]{2}[^\\/]/.test(p)) return { kind: "unc", raw: win32.normalize(p) };
  if (p.startsWith("/")) return { kind: "posix", segs: toSegments(p) };
  return null;
}

function startsWithSegs(segs: string[], prefix: string[]): boolean {
  return prefix.length <= segs.length && prefix.every((s, i) => segs[i] === s);
}

function formatParsed(p: ParsedPath): string {
  switch (p.kind) {
    case "drive":
      return `${p.drive}:\\${p.segs.join("\\")}`;
    case "wsl":
      return `\\\\wsl.localhost\\${p.distro}${p.segs.map((s) => `\\${s}`).join("")}`;
    case "unc":
      return p.raw;
    case "posix":
      return `/${p.segs.join("/")}`;
  }
}

/**
 * Convert an absolute path as seen by this process into the canonical form
 * stored in ecosystem.json. Returns null for relative paths.
 */
export function toCanonicalPath(p: string, env: PathEnv = currentPathEnv()): string | null {
  if (env.platform === "win32") {
    // `/foo` on Windows means "root of the current drive"
    const parsed = parseAnyPath(p.startsWith("/") && !p.startsWith("//") ? win32.resolve(p) : p);
    return parsed ? formatParsed(parsed) : null;
  }
  const parsed = parseAnyPath(p);
  if (!parsed) return null;
  if (!env.wslDistro || parsed.kind !== "posix") return formatParsed(parsed);

  const drivesRoot = toSegments(env.wslDrivesRoot);
  const distrosRoot = toSegments(env.wslDistrosRoot);
  const { segs } = parsed;

  // /mnt/wsl/<Distro>/... — another distro's bind-mounted root (checked
  // before drives: "/mnt/wsl" also sits under the default drives root)
  if (startsWithSegs(segs, distrosRoot) && segs.length > distrosRoot.length) {
    return formatParsed({
      kind: "wsl",
      distro: segs[distrosRoot.length],
      segs: segs.slice(distrosRoot.length + 1),
    });
  }
  // /mnt/c/... — a Windows drive
  const letter = segs[drivesRoot.length];
  if (startsWithSegs(segs, drivesRoot) && letter && /^[a-z]$/i.test(letter)) {
    return formatParsed({
      kind: "drive",
      drive: letter.toUpperCase(),
      segs: segs.slice(drivesRoot.length + 1),
    });
  }
  // Anything else lives in this distro
  return formatParsed({ kind: "wsl", distro: env.wslDistro, segs });
}

export type LocalPathResult = { path: string } | { error: string };

/**
 * Translate a stored (canonical or legacy) path into a path this process can
 * open. Legacy entries — plain POSIX paths written by older versions from
 * inside WSL — are still understood wherever they are unambiguous.
 */
export function toLocalPath(stored: string, env: PathEnv = currentPathEnv()): LocalPathResult {
  const parsed = parseAnyPath(stored);
  if (!parsed) return { error: `stored path "${stored}" is not absolute` };

  if (env.platform === "win32") {
    if (parsed.kind === "posix") {
      const [mnt, letter, ...rest] = parsed.segs;
      if (mnt === "mnt" && letter && /^[a-z]$/i.test(letter)) {
        return { path: formatParsed({ kind: "drive", drive: letter.toUpperCase(), segs: rest }) };
      }
      return {
        error:
          `"${stored}" is a Linux path registered by an older bridge version and the WSL distro it ` +
          "belongs to is unknown. Re-run bridge_register for this repo from inside WSL.",
      };
    }
    return { path: formatParsed(parsed) };
  }

  if (env.wslDistro) {
    switch (parsed.kind) {
      case "posix":
        return { path: formatParsed(parsed) };
      case "drive":
        return {
          path: posix.join(env.wslDrivesRoot, parsed.drive.toLowerCase(), ...parsed.segs),
        };
      case "wsl":
        if (parsed.distro.toLowerCase() === env.wslDistro.toLowerCase()) {
          return { path: formatParsed({ kind: "posix", segs: parsed.segs }) };
        }
        return { path: posix.join(env.wslDistrosRoot, parsed.distro, ...parsed.segs) };
      case "unc":
        return { error: `network path "${stored}" is not reachable from WSL — mount it first` };
    }
  }

  if (parsed.kind === "posix") return { path: formatParsed(parsed) };
  return { error: `Windows path "${stored}" is not reachable from ${env.platform}` };
}

/** Explain how to make another distro's files visible, for error messages. */
function foreignDistroHint(stored: string, env: PathEnv): string {
  const parsed = parseAnyPath(stored);
  if (
    parsed?.kind !== "wsl" ||
    !env.wslDistro ||
    parsed.distro.toLowerCase() === env.wslDistro.toLowerCase()
  ) {
    return "";
  }
  const mountPoint = posix.join(env.wslDistrosRoot, parsed.distro);
  return (
    ` It lives in WSL distro "${parsed.distro}". Expose that distro's filesystem by running, ` +
    `inside "${parsed.distro}": sudo mkdir -p ${mountPoint} && sudo mount --bind / ${mountPoint} ` +
    "(add it to that distro's /etc/wsl.conf [boot] command to survive restarts)."
  );
}

/**
 * Resolve a stored path to a local directory that actually exists. The error
 * explains why the directory is unreachable instead of letting reads fail
 * silently.
 */
function resolveStoredDir(stored: string, label: string): LocalPathResult {
  const env = currentPathEnv();
  const local = toLocalPath(stored, env);
  if ("error" in local) return { error: `${label}: ${local.error}` };
  if (!existsSync(local.path)) {
    return {
      error: `${label}: not found at ${local.path} from this environment.${foreignDistroHint(stored, env)}`,
    };
  }
  return local;
}

function repoRoot(name: string, entry: EcosystemEntry): LocalPathResult {
  return resolveStoredDir(entry.path, `repo "${name}"`);
}

function repoContractsDir(name: string, entry: EcosystemEntry): LocalPathResult {
  if (entry.contractsPath) {
    return resolveStoredDir(entry.contractsPath, `contracts of "${name}"`);
  }
  const root = repoRoot(name, entry);
  return "error" in root ? root : { path: join(root.path, ".context", "contracts") };
}

/** Read `<domain>.md` from another repo's contracts directory. */
async function readRepoContract(
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

// ─── Changelog helpers ────────────────────────────────────────────────────────

export function extractVersion(content: string): string | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match: ## Version, ## version, ## Version: 2.1, etc.
    const inline = line.match(/^##\s+version\s*[:：]\s*(.+)$/i);
    if (inline) {
      return inline[1].trim().replace(/^[v]/i, "");
    }
    // Match: ## Version (value on a following line)
    if (/^##\s+version\s*$/i.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const val = lines[j].trim();
        if (val.length === 0) continue;
        if (val.startsWith("#")) break;  // hit next section without a value
        return val.replace(/^[v]/i, "");
      }
    }
  }
  return null;
}

async function trackConsumedVersion(
  domain: string,
  content: string,
  source: string
): Promise<void> {
  // Don't pin self-consumption — owning a contract isn't consuming it
  if (source === "local") return;

  const version = extractVersion(content);
  if (!version) {
    console.error(
      `[context-bridge] contract "${domain}" from ${source} has no parseable ## Version section — skipping pin`
    );
    return;
  }

  const repoName = await currentRepoName();
  await updateEcosystem((ecosystem) => {
    const entry = ecosystem.repos[repoName];
    if (!entry) return false;  // repo not registered, can't track

    // Only update consumedAt when the version (or source) actually changes —
    // makes the field mean "since when has this consumption been at this version"
    const existing = entry.consumedVersions?.[domain];
    if (existing && existing.version === version && existing.source === source) {
      return false;  // no change, no write
    }

    entry.consumedVersions ??= {};
    entry.consumedVersions[domain] = {
      version,
      source,
      consumedAt: new Date().toISOString(),
    };
  });
}

export function extractSummary(content: string): string {
  const line = content.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim().replace(/^#+\s*/, "").slice(0, 80);
}

async function currentRepoName(): Promise<string> {
  const manifest = await readManifest();
  if (typeof manifest.project === "string" && manifest.project) {
    return manifest.project;
  }
  // Fallback: directory name of CWD
  return process.cwd().split(/[\\/]/).pop() ?? "unknown";
}

async function appendChangelog(entry: ChangelogEntry): Promise<void> {
  await mkdir(ECOSYSTEM_ROOT, { recursive: true });
  await appendFile(CHANGELOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Watch tokens map to either a specific domain name (e.g. "users" → entries
 * whose `domain === "users"`), or a category keyword that maps to one of the
 * stored type values. Categories accept both the singular type name and the
 * conventional plural the README example uses ("contracts" → type "contract").
 * Match is case-insensitive on the category keyword; domain match is strict.
 */
const WATCH_CATEGORY_ALIASES: Record<string, ChangelogEntry["type"]> = {
  contract: "contract",
  contracts: "contract",
  context: "context",
  manifest: "manifest",
  manifests: "manifest",
};

export function watchMatchesEntry(
  watchList: string[],
  entry: ChangelogEntry
): boolean {
  for (const w of watchList) {
    // Exact domain match — e.g. "users" matches a contract or context with domain "users"
    if (w === entry.domain) return true;
    // Category match — both singular ("contract") and plural ("contracts") supported
    const alias = WATCH_CATEGORY_ALIASES[w.toLowerCase()];
    if (alias && alias === entry.type) return true;
  }
  return false;
}

/**
 * Read the changelog. Each entry carries its line index so callers can use a
 * position cursor instead of timestamps: entries are written by processes on
 * different clocks (a WSL2 VM clock can lag the Windows host after sleep),
 * so "timestamp > lastCheckedAt" can skip entries. `lineCount` counts only
 * complete lines — a trailing partial line may still be mid-append.
 */
async function readChangelog(): Promise<{
  entries: Array<ChangelogEntry & { line: number }>;
  lineCount: number;
}> {
  let raw: string;
  try {
    raw = await readFile(CHANGELOG_PATH, "utf-8");
  } catch {
    return { entries: [], lineCount: 0 };
  }
  const lines = raw.split("\n");
  const lineCount = lines.length - 1;
  const entries: Array<ChangelogEntry & { line: number }> = [];
  for (let i = 0; i < lineCount; i++) {
    if (!lines[i].trim()) continue;
    try {
      entries.push({ ...JSON.parse(lines[i]), line: i });
    } catch {
      // skip malformed lines
    }
  }
  return { entries, lineCount };
}

// ─── Tool schemas ─────────────────────────────────────────────────────────────

const GetSchema = z.object({
  domain: z.string().min(1),
  component: z.string().optional(),
});

const UpdateSchema = z.object({
  domain: z.string().min(1),
  component: z.string().min(1),
  content: z.string().min(1),
});

const ListSchema = z.object({
  domain: z.string().optional(),
});

const GetFromSchema = z.object({
  repo: z.string().min(1),
  domain: z.string().min(1),
  component: z.string().optional(),
});

const ContractGetSchema = z.object({
  domain: z.string().min(1),
});

const ContractUpdateSchema = z.object({
  domain: z.string().min(1),
  content: z.string().min(1),
});

const ManifestUpdateSchema = z.object({
  patch: z.record(z.unknown()),
});

const RegisterSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  exposes: z.array(z.string()).min(1),
  stack: z.string().optional(),
  contractsPath: z.string().min(1).optional(),
});

const DiscoverSchema = z.object({
  name: z.string().optional(),
});

const ChangesSchema = z.object({
  since: z.string().optional(),
});

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "context-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── List tools ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bridge_manifest",
      description:
        "Return the full manifest — registry of all domains, components, contracts, and ownership rules. Call this FIRST at the start of any session.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "bridge_get",
      description:
        "Fetch a context file from the current repo's .context/ folder. " +
        "Call bridge_manifest first to know which domains exist.",
      inputSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Domain folder name as declared in manifest.json",
          },
          component: {
            type: "string",
            description:
              "File name without .md extension. Omit to list the domain directory.",
          },
        },
        required: ["domain"],
      },
    },
    {
      name: "bridge_update",
      description:
        "Write or overwrite a context file. Call this after implementing a feature to keep .context/ in sync with the actual code.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          component: { type: "string", description: "File name without .md" },
          content: { type: "string", description: "Full markdown content" },
        },
        required: ["domain", "component", "content"],
      },
    },
    {
      name: "bridge_list",
      description:
        "List all available context files. Optionally filter by domain. Use for discovery when you don't know what files exist.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
        },
        required: [],
      },
    },
    {
      name: "bridge_get_from",
      description:
        "Fetch a context file from another repo. " +
        "Pass a registered ecosystem repo name (from bridge_discover) or a relative path. " +
        "The other repo must have a .context/ folder.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description:
              "Ecosystem repo name (e.g. 'my-api') or relative path (e.g. '../my-api')",
          },
          domain: {
            type: "string",
            description: "Domain folder name in that repo's .context/",
          },
          component: {
            type: "string",
            description:
              "File name without .md. Omit to list the domain directory.",
          },
        },
        required: ["repo", "domain"],
      },
    },
    {
      name: "bridge_get_contract",
      description:
        "Fetch the API contract for a domain. Searches: 1) current repo's contracts, " +
        "2) all ecosystem repos that expose 'contracts'. No need to know which repo owns it. " +
        "Automatically pins the consumed version — bridge_changes will detect drift if the contract is updated later.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Contract domain name" },
        },
        required: ["domain"],
      },
    },
    {
      name: "bridge_update_contract",
      description:
        "Write or overwrite an API contract file. Use when adding a new endpoint, event shape, or shared type.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          content: { type: "string", description: "Full markdown content" },
        },
        required: ["domain", "content"],
      },
    },
    {
      name: "bridge_list_contracts",
      description: "List all existing contract files.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "bridge_register",
      description:
        "Register a repo in the shared ecosystem. Call once per repo to declare " +
        "its existence, path, and which domains it exposes publicly. " +
        "Other repos can then discover it via bridge_discover.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Unique repo name (e.g. 'game-backend', 'billing-api')",
          },
          path: {
            type: "string",
            description:
              "Absolute path to the repo root, in any notation: /home/..., /mnt/c/..., C:\\..., " +
              "or \\\\wsl.localhost\\<Distro>\\.... Stored in a form every Windows/WSL environment can translate.",
          },
          exposes: {
            type: "array",
            items: { type: "string" },
            description:
              "Domain names this repo exposes publicly (e.g. ['services', 'contracts'])",
          },
          stack: {
            type: "string",
            description: "Tech stack description (e.g. 'Node.js / Nakama')",
          },
          contractsPath: {
            type: "string",
            description:
              "Absolute path to the repo's contracts folder, only if it is NOT <path>/.context/contracts. " +
              "Filled in automatically when registering the current repo with a custom CONTRACTS_ROOT.",
          },
        },
        required: ["name", "path", "exposes"],
      },
    },
    {
      name: "bridge_discover",
      description:
        "Discover repos registered in the ecosystem. Call with no args to list " +
        "all repos and their exposed domains. Pass a name to get details " +
        "including its manifest. Use the repo name with bridge_get_from to read its files.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Repo name to inspect. Omit to list all repos.",
          },
        },
        required: [],
      },
    },
    {
      name: "bridge_changes",
      description:
        "Show changes from other repos and detect contract version drift. " +
        "Compares consumed contract versions (pinned by bridge_get_contract) against current versions. " +
        "Also shows changelog entries filtered by 'watches' in manifest.json (or all contract changes if no watches). " +
        "Call at session start after bridge_manifest and bridge_discover.",
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description:
              "ISO date to look back from (e.g. '2026-04-15'). " +
              "Omit to use this repo's last-checked cursor from the ecosystem.",
          },
        },
        required: [],
      },
    },
    {
      name: "bridge_sync_skills",
      description:
        "Install or update the companion Claude Code skills (context-reader, " +
        "context-feeder, context-bridge) into the current repo's .claude/skills/ folder. " +
        "Run once when onboarding a repo, or after updating the MCP server.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "bridge_manifest_update",
      description:
        "Deep-merge a patch object into manifest.json. Arrays are replaced wholesale, not appended — " +
        "read the current manifest first if you need to add to an existing array. " +
        "Use after registering a new domain, component, or contract.",
      inputSchema: {
        type: "object",
        properties: {
          patch: {
            type: "object",
            description:
              "Partial manifest object to deep-merge. Only provided keys are touched.",
          },
        },
        required: ["patch"],
      },
    },
  ],
}));

// ── Call tools ────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    // ── bridge_manifest ────────────────────────────────────────────────────
    case "bridge_manifest": {
      const manifest = await readManifest();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(manifest, null, 2),
          },
        ],
      };
    }

    // ── bridge_get ─────────────────────────────────────────────────────────
    case "bridge_get": {
      const { domain, component } = GetSchema.parse(args);
      const path = contextPath(CONTEXT_ROOT, domain, component);
      assertSafePath(path, [CONTEXT_ROOT]);

      if (component) {
        const content = await safeRead(path);
        if (!content) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No file found: .context/${domain}/${component}.md — use bridge_list to discover what exists`
          );
        }
        return { content: [{ type: "text", text: content }] };
      }

      // No component — list the domain directory
      const keys = await listMdFiles(path);
      if (keys.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Domain .context/${domain} is empty or does not exist.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Files in .context/${domain}:\n${keys.map((k) => `  - ${k}`).join("\n")}`,
          },
        ],
      };
    }

    // ── bridge_update ──────────────────────────────────────────────────────
    case "bridge_update": {
      const { domain, component, content } = UpdateSchema.parse(args);
      const path = contextPath(CONTEXT_ROOT, domain, component);
      assertSafePath(path, [CONTEXT_ROOT]);
      await mkdir(join(CONTEXT_ROOT, domain), { recursive: true });
      await writeFileAtomic(path, content);
      await appendChangelog({
        timestamp: new Date().toISOString(),
        repo: await currentRepoName(),
        type: "context",
        domain,
        component,
        summary: extractSummary(content),
      });
      return {
        content: [
          {
            type: "text",
            text: `✓ Written: .context/${domain}/${component}.md`,
          },
        ],
      };
    }

    // ── bridge_list ────────────────────────────────────────────────────────
    case "bridge_list": {
      const { domain } = ListSchema.parse(args ?? {});
      const base = domain ? join(CONTEXT_ROOT, domain) : CONTEXT_ROOT;
      assertSafePath(base, [CONTEXT_ROOT]);
      const keys = await listMdFiles(base);
      const prefix = domain ? `.context/${domain}/` : ".context/";

      return {
        content: [
          {
            type: "text",
            text:
              keys.length > 0
                ? keys.map((k) => `  - ${prefix}${k}`).join("\n")
                : "No context files found.",
          },
        ],
      };
    }

    // ── bridge_get_from ────────────────────────────────────────────────────
    case "bridge_get_from": {
      const { repo, domain, component } = GetFromSchema.parse(args);

      // Resolve repo name from ecosystem, or treat as relative/absolute path.
      // Absolute paths may use any notation (C:\..., \\wsl.localhost\..., /mnt/c/...).
      const ecosystem = await readEcosystem();
      const entry = ecosystem.repos[repo];
      const resolved: LocalPathResult = entry
        ? repoRoot(repo, entry)
        : parseAnyPath(repo)
          ? resolveStoredDir(toCanonicalPath(repo) ?? repo, `path "${repo}"`)
          : { path: resolve(process.cwd(), repo) };
      if ("error" in resolved) {
        throw new McpError(ErrorCode.InvalidParams, resolved.error);
      }
      const externalRoot = join(resolved.path, ".context");
      const path = contextPath(externalRoot, domain, component);
      assertSafePath(path, [externalRoot]);

      if (component) {
        const content = await safeRead(path);
        if (!content) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No file found: ${repo}/.context/${domain}/${component}.md`
          );
        }
        return { content: [{ type: "text", text: content }] };
      }

      const keys = await listMdFiles(path);
      return {
        content: [
          {
            type: "text",
            text:
              keys.length > 0
                ? keys.map((k) => `  - .context/${domain}/${k}`).join("\n")
                : `Domain .context/${domain} is empty or does not exist in ${repo}.`,
          },
        ],
      };
    }

    // ── bridge_get_contract ────────────────────────────────────────────────
    case "bridge_get_contract": {
      const { domain } = ContractGetSchema.parse(args);

      // 1. Try current repo's contracts
      const localPath = contractPath(domain);
      assertSafePath(localPath, [CONTRACTS_ROOT]);
      const localContent = await safeRead(localPath);
      if (localContent) {
        await trackConsumedVersion(domain, localContent, "local");
        return { content: [{ type: "text", text: localContent }] };
      }

      // 2. Search ecosystem repos that expose "contracts"
      const ecosystem = await readEcosystem();
      const unreachable: string[] = [];
      for (const [repoName, entry] of Object.entries(ecosystem.repos)) {
        if (!entry.exposes.includes("contracts")) continue;
        const result = await readRepoContract(repoName, entry, domain);
        if ("error" in result) {
          unreachable.push(result.error);
          continue;
        }
        const repoContent = result.content;
        if (repoContent) {
          await trackConsumedVersion(domain, repoContent, repoName);
          return {
            content: [
              { type: "text", text: `✓ Resolved from ecosystem repo: ${repoName}` },
              { type: "text", text: repoContent },
            ],
          };
        }
      }

      // 3. Not found — list available repos
      const available = Object.entries(ecosystem.repos)
        .filter(([, e]) => e.exposes.includes("contracts"))
        .map(([n]) => n);
      const hint =
        available.length > 0
          ? ` Ecosystem repos with contracts: ${available.join(", ")}.`
          : " No ecosystem repos expose contracts. Use bridge_register to add repos.";
      const unreachableHint =
        unreachable.length > 0
          ? `\nUnreachable from this environment (not searched):\n${unreachable.map((u) => `  - ${u}`).join("\n")}`
          : "";
      throw new McpError(
        ErrorCode.InvalidParams,
        `No contract found for "${domain}" in local or ecosystem repos.${hint}${unreachableHint}`
      );
    }

    // ── bridge_register ──────────────────────────────────────────────────
    case "bridge_register": {
      const { name: repoName, path: repoPath, exposes, stack, contractsPath } =
        RegisterSchema.parse(args);
      const canonicalPath = toCanonicalPath(repoPath);
      if (!canonicalPath) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `path must be absolute (got: "${repoPath}"). Use an absolute path to the repo root.`
        );
      }

      // Contracts outside <repo>/.context/contracts must be recorded so other
      // repos can find them. Registering the current repo with a custom
      // CONTRACTS_ROOT fills this in automatically.
      let canonicalContracts: string | undefined;
      if (contractsPath) {
        canonicalContracts = toCanonicalPath(contractsPath) ?? undefined;
        if (!canonicalContracts) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `contractsPath must be absolute (got: "${contractsPath}").`
          );
        }
      } else {
        const local = toLocalPath(canonicalPath);
        const isCurrentRepo =
          "path" in local && resolve(local.path) === resolve(CONTEXT_ROOT, "..");
        if (isCurrentRepo && CONTRACTS_ROOT !== join(CONTEXT_ROOT, "contracts")) {
          canonicalContracts = toCanonicalPath(CONTRACTS_ROOT) ?? undefined;
        }
      }

      await updateEcosystem((ecosystem) => {
        const previous = ecosystem.repos[repoName];
        ecosystem.repos[repoName] = {
          // Re-registering must not reset this repo's pins and changelog cursor
          ...previous,
          path: canonicalPath,
          contractsPath: canonicalContracts,
          exposes,
          stack,
          registeredAt: new Date().toISOString().slice(0, 10),
        };
        if (!canonicalContracts) delete ecosystem.repos[repoName].contractsPath;
      });

      const reach = resolveStoredDir(canonicalPath, `repo "${repoName}"`);
      const warning =
        "error" in reach ? `\n  ⚠ ${reach.error}` : "";
      return {
        content: [
          {
            type: "text",
            text: `✓ Registered "${repoName}"\n  exposes: ${exposes.join(", ")}${stack ? `\n  stack: ${stack}` : ""}${warning}`,
          },
        ],
      };
    }

    // ── bridge_discover ──────────────────────────────────────────────────
    case "bridge_discover": {
      const { name: repoName } = DiscoverSchema.parse(args ?? {});
      const ecosystem = await readEcosystem();

      if (repoName) {
        const entry = ecosystem.repos[repoName];
        if (!entry) {
          const available = Object.keys(ecosystem.repos);
          throw new McpError(
            ErrorCode.InvalidParams,
            `Repo "${repoName}" not found in ecosystem.${available.length > 0 ? ` Available: ${available.join(", ")}` : " No repos registered yet. Use bridge_register."}`
          );
        }
        // Try to read that repo's manifest for extra detail
        const root = repoRoot(repoName, entry);
        const repoManifest =
          "path" in root
            ? await safeRead(join(root.path, ".context", "manifest.json"))
            : null;
        // Return details without exposing the absolute path
        const detail: Record<string, unknown> = {
          name: repoName,
          exposes: entry.exposes,
          stack: entry.stack,
          registeredAt: entry.registeredAt,
          reachable: "path" in root,
        };
        if ("error" in root) detail.unreachableReason = root.error;
        if (repoManifest) {
          try {
            detail.manifest = JSON.parse(repoManifest);
          } catch {
            // ignore parse errors
          }
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(detail, null, 2) },
          ],
        };
      }

      // List all repos
      const repos = Object.entries(ecosystem.repos);
      if (repos.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No repos registered. Use bridge_register to add repos to the ecosystem.",
            },
          ],
        };
      }
      const lines = repos.map(([n, e]) => {
        const reach = repoRoot(n, e);
        const flag = "error" in reach ? "\n    ⚠ unreachable from this environment" : "";
        return `  - ${n} (${e.stack ?? "unknown stack"})\n    exposes: ${e.exposes.join(", ")}${flag}`;
      });
      return {
        content: [
          { type: "text", text: `Ecosystem repos:\n\n${lines.join("\n\n")}` },
        ],
      };
    }

    // ── bridge_update_contract ─────────────────────────────────────────────
    case "bridge_update_contract": {
      const { domain, content } = ContractUpdateSchema.parse(args);
      const path = contractPath(domain);
      assertSafePath(path, [CONTRACTS_ROOT]);
      await mkdir(CONTRACTS_ROOT, { recursive: true });
      await writeFileAtomic(path, content);
      await appendChangelog({
        timestamp: new Date().toISOString(),
        repo: await currentRepoName(),
        type: "contract",
        domain,
        component: null,
        summary: extractSummary(content),
      });
      return {
        content: [
          { type: "text", text: `✓ Written: contracts/${domain}.md` },
        ],
      };
    }

    // ── bridge_list_contracts ──────────────────────────────────────────────
    case "bridge_list_contracts": {
      const keys = await listMdFiles(CONTRACTS_ROOT);
      return {
        content: [
          {
            type: "text",
            text:
              keys.length > 0
                ? keys.map((k) => `  - contracts/${k}`).join("\n")
                : "No contracts found.",
          },
        ],
      };
    }

    // ── bridge_manifest_update ─────────────────────────────────────────────
    case "bridge_manifest_update": {
      const { patch } = ManifestUpdateSchema.parse(args);
      const current = await readManifest();
      const merged = deepMerge(current, patch);
      await writeManifest(merged);
      await appendChangelog({
        timestamp: new Date().toISOString(),
        repo: await currentRepoName(),
        type: "manifest",
        domain: "manifest",
        component: null,
        summary: "manifest updated",
      });
      return {
        content: [
          {
            type: "text",
            text: `✓ manifest.json updated.\n\n${JSON.stringify(merged, null, 2)}`,
          },
        ],
      };
    }

    // ── bridge_changes ──────────────────────────────────────────────────
    case "bridge_changes": {
      const { since } = ChangesSchema.parse(args ?? {});
      const repoName = await currentRepoName();
      const manifest = await readManifest();
      const watches = manifest.watches as Record<string, string[]> | undefined;
      const ecosystem = await readEcosystem();
      const myEntry = ecosystem.repos[repoName];

      // ── Part 1: changelog entries since cursor ──
      // Default cursor is a line position, immune to clock skew between the
      // Windows host and WSL2 VMs. An explicit `since`, or a repo that has
      // never checked (or a truncated changelog), falls back to timestamps.
      const { entries: allEntries, lineCount } = await readChangelog();
      const lineCursor =
        !since &&
        myEntry?.changelogCursor !== undefined &&
        myEntry.changelogCursor <= lineCount
          ? myEntry.changelogCursor
          : undefined;
      const cursor = since ?? myEntry?.lastCheckedAt ?? "1970-01-01T00:00:00Z";

      const relevant = allEntries.filter((e) => {
        if (e.repo === repoName) return false;
        if (lineCursor !== undefined ? e.line < lineCursor : e.timestamp <= cursor) {
          return false;
        }
        if (watches) {
          const watchList = watches[e.repo];
          if (!watchList) return false;
          return watchMatchesEntry(watchList, e);
        }
        // No watches declared — default to surfacing all contract changes
        // (the most common "I depend on this" signal) from other repos.
        return e.type === "contract";
      });

      const changeLines = relevant.map((e) => {
        const date = e.timestamp.slice(0, 10);
        const target = e.component
          ? `${e.domain}/${e.component}`
          : e.domain;
        let line = `  [${date}] ${e.repo} updated ${e.type} "${target}"`;
        if (e.summary) line += `\n    → ${e.summary}`;
        return line;
      });

      // ── Part 2: version drift detection ──
      const driftLines: string[] = [];
      const consumed = myEntry?.consumedVersions ?? {};

      for (const [contractDomain, pin] of Object.entries(consumed)) {
        const sourceEntry = ecosystem.repos[pin.source];
        // Source repo no longer in ecosystem — surface as orphan dependency
        if (!sourceEntry) {
          driftLines.push(
            `  ⚠ contract "${contractDomain}": pinned to v${pin.version} from "${pin.source}", but "${pin.source}" is no longer registered in the ecosystem`
          );
          continue;
        }

        const result = await readRepoContract(pin.source, sourceEntry, contractDomain);
        if ("error" in result) {
          driftLines.push(
            `  ⚠ contract "${contractDomain}": pinned to v${pin.version}, but drift cannot be checked — ${result.error}`
          );
          continue;
        }
        const currentContent = result.content;

        if (!currentContent) {
          driftLines.push(
            `  ⚠ contract "${contractDomain}": pinned to v${pin.version} from "${pin.source}", but the contract file no longer exists in that repo`
          );
          continue;
        }

        const currentVersion = extractVersion(currentContent);
        if (!currentVersion) continue;
        if (currentVersion !== pin.version) {
          driftLines.push(
            `  ⚠ contract "${contractDomain}": you consumed v${pin.version} from ${pin.source} on ${pin.consumedAt.slice(0, 10)}, current is v${currentVersion}`
          );
        }
      }

      // ── Update cursors — re-read under lock, touch only our own entry ──
      if (myEntry) {
        await updateEcosystem((eco) => {
          const entry = eco.repos[repoName];
          if (!entry) return false;
          entry.lastCheckedAt = new Date().toISOString();
          entry.changelogCursor = lineCount;
        });
      }

      // ── Build response ──
      const sections: string[] = [];

      if (driftLines.length > 0) {
        sections.push(
          `Version drift detected (${driftLines.length}):\n\n${driftLines.join("\n\n")}`
        );
      }

      if (changeLines.length > 0) {
        sections.push(
          `${changeLines.length} change(s) since ${cursor.slice(0, 10)}:\n\n${changeLines.join("\n\n")}`
        );
      }

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No changes or version drift since ${cursor.slice(0, 10)}.`,
            },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: sections.join("\n\n---\n\n") },
        ],
      };
    }

    // ── bridge_sync_skills ────────────────────────────────────────────────
    case "bridge_sync_skills": {
      const targetRoot = join(process.cwd(), ".claude", "skills");

      if (!existsSync(SKILLS_SOURCE)) {
        throw new McpError(
          ErrorCode.InternalError,
          `Skills source not found. Is the MCP server installed correctly?`
        );
      }

      // Walk a skill directory and return relative paths of all files
      async function walkFiles(root: string): Promise<string[]> {
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

      const added: string[] = [];
      const updated: string[] = [];
      const unchanged: string[] = [];

      for (const skill of BRIDGE_SKILLS) {
        const src = join(SKILLS_SOURCE, skill);
        if (!existsSync(src)) continue;
        const dest = join(targetRoot, skill);

        const files = await walkFiles(src);
        for (const rel of files) {
          const srcFile = join(src, rel);
          const destFile = join(dest, rel);
          const newContent = await readFile(srcFile, "utf-8");
          const oldContent = await safeRead(destFile);
          const label = `${skill}/${rel}`;

          if (oldContent === null) {
            await mkdir(join(destFile, ".."), { recursive: true });
            await writeFile(destFile, newContent, "utf-8");
            added.push(label);
          } else if (oldContent !== newContent) {
            await writeFile(destFile, newContent, "utf-8");
            updated.push(label);
          } else {
            unchanged.push(label);
          }
        }
      }

      const lines: string[] = [];
      if (added.length > 0) {
        lines.push(`Added (${added.length}):\n${added.map((f) => `  + ${f}`).join("\n")}`);
      }
      if (updated.length > 0) {
        lines.push(`Updated (${updated.length}):\n${updated.map((f) => `  ~ ${f}`).join("\n")}`);
      }
      if (added.length === 0 && updated.length === 0) {
        lines.push(`✓ All ${unchanged.length} skill files already up to date.`);
      } else {
        lines.push(`✓ Synced to .claude/skills/ (${unchanged.length} unchanged).`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

// ─── Deep merge util ──────────────────────────────────────────────────────────

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

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(CONTEXT_ROOT, { recursive: true });
  if (!existsSync(MANIFEST_PATH)) {
    await writeManifest({ version: "1.0", domains: {} });
    console.error(`[context-bridge] Initialized manifest at ${MANIFEST_PATH}`);
  }

  // Ensure ecosystem directory exists
  await mkdir(ECOSYSTEM_ROOT, { recursive: true });

  console.error(`[context-bridge] CONTEXT_ROOT   = ${CONTEXT_ROOT}`);
  console.error(`[context-bridge] CONTRACTS_ROOT = ${CONTRACTS_ROOT}`);
  console.error(`[context-bridge] ECOSYSTEM_PATH = ${ECOSYSTEM_PATH}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[context-bridge] Context Bridge MCP running on stdio");
}

function isInvokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().catch((err) => {
    console.error("[context-bridge] Fatal:", err);
    process.exit(1);
  });
}
