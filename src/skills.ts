import { readFile, readdir, mkdir, stat, rm, chmod } from "fs/promises";
import { join } from "path";
import { cfg } from "./config.js";
import { appendChangelog, lastLoggedVersion } from "./changelog.js";
import { repoRoot } from "./ecosystem.js";
import { invalidParams } from "./errors.js";
import { safeRead, walkFiles, writeFileAtomic } from "./fsutil.js";
import { currentRepoName } from "./manifest.js";
import { assertSafePath, type LocalPathResult } from "./paths.js";
import type { Ecosystem } from "./types.js";

// ─── Published skills ─────────────────────────────────────────────────────────
//
// A repo publishes skills under `.context/skills/<name>/` (SKILL.md plus any
// sibling files) and lists them in its manifest under `skills`. Other repos
// install copies into their own `.claude/skills/<name>/`, recorded in their
// manifest under `installedSkills`.

export interface InstalledSkill {
  from: string;     // provider repo name in the ecosystem
  version: string | null;
}

export interface PublishedSkill {
  name: string;
  version: string | null;
  description: string | null;
  dir: string;      // local path of the skill folder
}

/** Skill names become folder names: no separators, no leading dot. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSkillName(skill: string): void {
  if (!SKILL_NAME_RE.test(skill)) {
    throw invalidParams(
      `Invalid skill name "${skill}" — use letters, digits, ".", "_" and "-" only`
    );
  }
}

export function consumerSkillsRoot(): string {
  return join(cfg().cwd, ".claude", "skills");
}

function unquote(v: string): string {
  return v.trim().replace(/^(["'])(.*)\1$/s, "$2");
}

/**
 * Pull `description` and `metadata.version` (or a top-level `version`) out of
 * SKILL.md YAML frontmatter. Deliberately minimal: handles plain scalars and
 * `>`/`|` block scalars, which is what skill files use.
 */
export function parseSkillFrontmatter(content: string): {
  description: string | null;
  version: string | null;
} {
  const m = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return { description: null, version: null };
  const lines = m[1].split(/\r?\n/);
  const indent = (l: string) => l.length - l.trimStart().length;
  let description: string | null = null;
  let topVersion: string | null = null;
  let metaVersion: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indent(line) !== 0) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    if (key === "description") {
      if (/^[>|][+-]?$/.test(value) || value === "") {
        const block: string[] = [];
        while (i + 1 < lines.length && (lines[i + 1].trim() === "" || indent(lines[i + 1]) > 0)) {
          block.push(lines[++i].trim());
        }
        description = block.join(value.startsWith("|") ? "\n" : " ").trim() || null;
      } else {
        description = unquote(value);
      }
    } else if (key === "version") {
      topVersion = unquote(value) || null;
    } else if (key === "metadata") {
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || indent(lines[i + 1]) > 0)) {
        const sub = lines[++i].trim().match(/^version\s*:\s*(.+)$/);
        if (sub) metaVersion = unquote(sub[1]);
      }
    }
  }
  return { description, version: metaVersion ?? topVersion };
}

/**
 * List the skills a repo publishes: folders under `<contextRoot>/skills/`
 * that contain a SKILL.md. The manifest's `skills.<name>.version` wins over
 * the frontmatter's `metadata.version`.
 */
export async function listPublishedSkills(contextRoot: string): Promise<PublishedSkill[]> {
  const skillsDir = join(contextRoot, "skills");
  let manifestSkills: Record<string, { version?: unknown; description?: unknown }> = {};
  const rawManifest = await safeRead(join(contextRoot, "manifest.json"));
  if (rawManifest) {
    try {
      const parsed = JSON.parse(rawManifest);
      if (parsed?.skills && typeof parsed.skills === "object") manifestSkills = parsed.skills;
    } catch {
      // a broken provider manifest still lets the frontmatter speak
    }
  }

  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PublishedSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SKILL_NAME_RE.test(e.name)) continue;
    const dir = join(skillsDir, e.name);
    const skillMd = await safeRead(join(dir, "SKILL.md"));
    if (skillMd === null) continue;
    const front = parseSkillFrontmatter(skillMd);
    const fromManifest = manifestSkills[e.name] ?? {};
    out.push({
      name: e.name,
      version:
        typeof fromManifest.version === "string" ? fromManifest.version : front.version,
      description:
        typeof fromManifest.description === "string"
          ? fromManifest.description
          : front.description,
      dir,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The `.context/` folder of a registered repo that exposes "skills". */
export function providerContextRoot(
  ecosystem: Ecosystem,
  repo: string
): LocalPathResult {
  const entry = ecosystem.repos[repo];
  if (!entry) {
    const available = Object.entries(ecosystem.repos)
      .filter(([, e]) => e.exposes.includes("skills"))
      .map(([n]) => n);
    return {
      error:
        `repo "${repo}" is not registered in the ecosystem.` +
        (available.length > 0 ? ` Repos exposing skills: ${available.join(", ")}.` : ""),
    };
  }
  if (!entry.exposes.includes("skills")) {
    return {
      error: `repo "${repo}" does not expose "skills" — its owner must add "skills" to exposes via bridge_register`,
    };
  }
  const root = repoRoot(repo, entry);
  return "error" in root ? root : { path: join(root.path, ".context") };
}


export interface CopyReport {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
}

export function emptyReport(): CopyReport {
  return { added: [], updated: [], unchanged: [], removed: [] };
}

/**
 * Copy a skill folder byte for byte (scripts, CRLF and binary files stay
 * intact; nothing is executed or rewritten). With `prune`, files in `dest`
 * that no longer exist in `src` are deleted — only for folders the bridge
 * owns.
 */
export async function copySkillDir(
  src: string,
  dest: string,
  label: string,
  prune: boolean,
  report: CopyReport
): Promise<void> {
  const files = await walkFiles(src);
  const wanted = new Set(files);
  for (const rel of files) {
    const srcFile = join(src, rel);
    const destFile = join(dest, rel);
    assertSafePath(destFile, [dest]);
    const newContent = await readFile(srcFile);
    const oldContent = await readFile(destFile).catch(() => null);
    const name = `${label}/${rel}`;
    if (oldContent !== null && oldContent.equals(newContent)) {
      report.unchanged.push(name);
      continue;
    }
    await mkdir(join(destFile, ".."), { recursive: true });
    await writeFileAtomic(destFile, newContent);
    // Keep the executable bit on scripts; drvfs may refuse chmod — harmless.
    const mode = (await stat(srcFile)).mode & 0o777;
    if (mode & 0o111) await chmod(destFile, mode).catch(() => {});
    (oldContent === null ? report.added : report.updated).push(name);
  }
  if (!prune) return;
  for (const rel of await walkFiles(dest)) {
    if (wanted.has(rel)) continue;
    await rm(join(dest, rel), { force: true });
    report.removed.push(`${label}/${rel}`);
  }
}

export function formatCopyReport(report: CopyReport): string[] {
  const lines: string[] = [];
  const section = (title: string, mark: string, items: string[]) => {
    if (items.length > 0) {
      lines.push(`${title} (${items.length}):\n${items.map((f) => `  ${mark} ${f}`).join("\n")}`);
    }
  };
  section("Added", "+", report.added);
  section("Updated", "~", report.updated);
  section("Removed", "-", report.removed);
  return lines;
}

export function readInstalledSkills(manifest: Record<string, unknown>): Record<string, InstalledSkill> {
  const v = manifest.installedSkills;
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, InstalledSkill>)
    : {};
}

/** Skill versions in a manifest's `skills` registry. */
function manifestSkillVersions(m: Record<string, unknown>): Record<string, string | null> {
  const s = m.skills;
  if (!s || typeof s !== "object" || Array.isArray(s)) return {};
  return Object.fromEntries(
    Object.entries(s as Record<string, { version?: unknown }>).map(([k, v]) => [
      k,
      typeof v?.version === "string" ? v.version : null,
    ])
  );
}

/**
 * Log skills whose manifest entry changed between two manifests. The "from"
 * side is the last version actually published (logged), not the old
 * manifest: the manifest may have been edited by hand since.
 * Returns the skills that were logged.
 */
export async function logSkillChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Promise<string[]> {
  const old = manifestSkillVersions(before);
  const cur = manifestSkillVersions(after);
  const repo = await currentRepoName();
  const logged: string[] = [];
  const log = async (skill: string, summary: string, version?: string) => {
    await appendChangelog({
      timestamp: new Date().toISOString(),
      repo,
      type: "skill",
      domain: skill,
      component: null,
      summary,
      ...(version ? { version } : {}),
    });
    logged.push(skill);
  };
  for (const [skill, version] of Object.entries(cur)) {
    if (skill in old && old[skill] === version) continue;
    const published = await lastLoggedVersion(repo, "skill", skill);
    if (version !== null && published === version) continue;  // already published
    const shown = version ?? "(unversioned)";
    await log(skill, published ? `${published} -> ${shown}` : `published ${shown}`, version ?? undefined);
  }
  for (const skill of Object.keys(old)) {
    if (!(skill in cur)) await log(skill, "unpublished");
  }
  return logged;
}
