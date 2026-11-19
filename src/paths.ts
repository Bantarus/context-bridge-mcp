import { relative, isAbsolute, sep, posix, win32 } from "path";
import { existsSync } from "fs";
import { invalidParams } from "./errors.js";

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
    throw invalidParams("Path escapes allowed roots");
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
  if (!parsed) return { error: "its stored path is not absolute" };

  if (env.platform === "win32") {
    if (parsed.kind === "posix") {
      const [mnt, letter, ...rest] = parsed.segs;
      if (mnt === "mnt" && letter && /^[a-z]$/i.test(letter)) {
        return { path: formatParsed({ kind: "drive", drive: letter.toUpperCase(), segs: rest }) };
      }
      return {
        error:
          "it has a Linux path registered by an older bridge version and the WSL distro it " +
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
        return { error: "it lives on a network path that is not reachable from WSL — mount it first" };
    }
  }

  if (parsed.kind === "posix") return { path: formatParsed(parsed) };
  return { error: `it lives on a Windows path, which is not reachable from ${env.platform}` };
}

/** Explain how to make another distro's files visible, for error messages. */
export function foreignDistroHint(stored: string, env: PathEnv): string {
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
    ` It lives in WSL distro "${parsed.distro}" — make sure it is running, then expose its ` +
    `filesystem by running inside "${parsed.distro}": sudo mkdir -p ${mountPoint} && ` +
    `sudo mount --bind / ${mountPoint}. To keep it mounted permanently, install the ` +
    "wsl-distro-bind service from the README (a wsl.conf boot command is not enough)."
  );
}

/**
 * Resolve a stored path to a local directory that actually exists. The error
 * explains why the directory is unreachable instead of letting reads fail
 * silently.
 */
export function resolveStoredDir(stored: string, label: string): LocalPathResult {
  const env = currentPathEnv();
  const local = toLocalPath(stored, env);
  if ("error" in local) return { error: `${label}: ${local.error}` };
  if (!existsSync(local.path)) {
    return {
      error: `${label}: not found from this environment.${foreignDistroHint(stored, env)}`,
    };
  }
  return local;
}
