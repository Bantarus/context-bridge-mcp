import { cfg, ownRepoRoot } from "./config.js";
import { currentPathEnv, toLocalPath, type PathEnv } from "./paths.js";
import { resolve } from "path";
import type { Ecosystem } from "./types.js";

// ─── Path redaction ───────────────────────────────────────────────────────────
//
// Output must never reveal where another repo lives on disk: an agent that
// learns the path can read that repo with its own file tools instead of
// going through the bridge. Every tool response, CLI output and error passes
// through this redactor, which replaces each registered repo's location (in
// every notation this process might print it) with a placeholder naming the
// repo.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All the spellings under which `p` could show up in output. */
function pathSpellings(p: string): string[] {
  const out = new Set<string>();
  for (const base of [p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")]) {
    const trimmed = base.replace(/[\\/]+$/, "");
    if (trimmed.length < 2) continue;  // never redact "/" or "C:"
    out.add(trimmed);
    out.add(JSON.stringify(trimmed).slice(1, -1));  // as it appears inside JSON
  }
  return [...out];
}

export function buildPathRedactor(
  ecosystem: Ecosystem,
  env: PathEnv = currentPathEnv(),
  ownRoot: string = ownRepoRoot()
): (text: string) => string {
  const rules: Array<{ spelling: string; label: string }> = [];
  const add = (p: string | undefined, label: string) => {
    if (!p) return;
    for (const spelling of pathSpellings(p)) rules.push({ spelling, label });
  };

  for (const [name, entry] of Object.entries(ecosystem.repos)) {
    const local = toLocalPath(entry.path, env);
    // The current repo's own path is no secret to an agent working in it
    if ("path" in local && resolve(local.path) === ownRoot) continue;
    const label = `<repo:${name}>`;
    for (const stored of [entry.path, entry.contractsPath]) {
      if (!stored) continue;
      add(stored, label);
      const l = toLocalPath(stored, env);
      if ("path" in l) add(l.path, label);
    }
  }
  // ecosystem.json lists every repo's path
  add(cfg().ecosystemRoot, "<ECOSYSTEM_ROOT>");
  if (rules.length === 0) return (t) => t;

  // Longest first, so a repo nested in another is labelled by itself
  rules.sort((a, b) => b.spelling.length - a.spelling.length);
  const labelFor = new Map<string, string>();
  for (const r of rules) {
    const key = r.spelling.toLowerCase();
    if (!labelFor.has(key)) labelFor.set(key, r.label);
  }
  // Case-insensitive (drive letters, Windows paths); only whole path
  // segments, so /srv/app never matches inside /srv/app2. A following "."
  // counts as a boundary so sentence-final paths are caught too.
  const pattern = new RegExp(
    `(?:${[...labelFor.keys()].map(escapeRegExp).join("|")})(?![^\\s\\\\/"'\`.,;:)\\]}>])`,
    "gi"
  );
  return (text) => text.replace(pattern, (m) => labelFor.get(m.toLowerCase()) ?? m);
}
