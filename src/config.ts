import { join, resolve } from "path";
import { homedir } from "os";

// ─── Config ──────────────────────────────────────────────────────────────────
//
// Every root the bridge reads or writes, derived from the environment and the
// working directory. The MCP server loads it once at start-up; the CLI may
// replace it (e.g. `--repo <path>`) before running an operation.

export interface Config {
  /** Repo root the bridge acts for (the server's cwd, or the CLI's resolved repo). */
  cwd: string;
  contextRoot: string;
  contractsRoot: string;
  manifestPath: string;
  ecosystemRoot: string;
  ecosystemPath: string;
  changelogPath: string;
  ecosystemLockPath: string;
  busRoot: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Config {
  const contextRoot = resolve(env.CONTEXT_ROOT || join(cwd, ".context"));
  const ecosystemRoot = resolve(env.ECOSYSTEM_ROOT || join(homedir(), ".context-bridge"));
  return {
    cwd,
    contextRoot,
    contractsRoot: resolve(env.CONTRACTS_ROOT || join(contextRoot, "contracts")),
    manifestPath: join(contextRoot, "manifest.json"),
    ecosystemRoot,
    ecosystemPath: join(ecosystemRoot, "ecosystem.json"),
    changelogPath: join(ecosystemRoot, "changelog.jsonl"),
    ecosystemLockPath: join(ecosystemRoot, "ecosystem.lock"),
    busRoot: join(ecosystemRoot, "bus"),
  };
}

let current: Config = loadConfig();

export function cfg(): Config {
  return current;
}

export function setConfig(next: Config): void {
  current = next;
}

/** The repo root that owns CONTEXT_ROOT. */
export function ownRepoRoot(): string {
  return resolve(current.contextRoot, "..");
}

// Skills shipped with this MCP server (relative to compiled dist/config.js)
export const SKILLS_SOURCE = resolve(import.meta.dirname, "..", ".claude", "skills");
export const BRIDGE_SKILLS = ["context-reader", "context-feeder", "context-bridge"];
