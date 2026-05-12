/**
 * Drive Claude Code in non-interactive mode against a sandboxed context-bridge.
 *
 * These tests verify that a REAL agent can find and use the bridge tools
 * correctly given only their descriptions. They run via your Claude Code
 * subscription (no ANTHROPIC_API_KEY needed) and cost a few cents per
 * invocation, so they are skipped by default and only run when
 * RUN_E2E_HEADLESS=1 is set.
 *
 * Auth resolution (in order):
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (CI: set from `claude setup-token`)
 *   2. ~/.claude/.credentials.json from an interactive `claude` login
 *   3. ANTHROPIC_API_KEY env var
 * We do NOT pass --bare so all three resolution paths are available.
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIST = resolve(__dirname, "../../dist/index.js");

/** Default model for E2E tests — pinned for reproducibility and cost. */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** Default per-test budget. Generous for Haiku; a hard stop against runaway loops. */
export const DEFAULT_BUDGET_USD = 0.1;

export interface E2EFixture {
  /** Working directory the agent runs in. */
  cwd: string;
  /** Same as cwd by default — the repo root the bridge sees. */
  ctxRoot: string;
  /** Shared ecosystem directory passed to the bridge via env. */
  ecoRoot: string;
  /** Tear down the fixture (rm -rf on the tmp root). */
  cleanup: () => void;
}

/**
 * Create a clean tmp working dir with seeded `.context/manifest.json` and an
 * empty ecosystem dir. Both paths get injected into the bridge via the
 * MCP-config file's `env`.
 */
export function makeE2EFixture(
  options: { manifest?: Record<string, unknown> } = {}
): E2EFixture {
  const root = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
  const ctxRoot = join(root, ".context");
  const ecoRoot = join(root, "ecosystem");
  mkdirSync(ctxRoot, { recursive: true });
  mkdirSync(ecoRoot, { recursive: true });
  writeFileSync(
    join(ctxRoot, "manifest.json"),
    JSON.stringify(options.manifest ?? { version: "1.0", domains: {} }, null, 2),
    "utf-8"
  );
  return {
    cwd: root,
    ctxRoot,
    ecoRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface HeadlessOptions {
  /** Working dir the agent runs in. */
  cwd: string;
  /** Path to seed into the bridge as ECOSYSTEM_ROOT via env. */
  ecosystemRoot: string;
  /** The user prompt sent via `-p`. */
  prompt: string;
  /** Override model (default: Haiku 4.5). */
  model?: string;
  /** Override budget cap in USD (default 0.10). */
  maxBudgetUsd?: number;
  /** Override the tool allowlist (default: only context-bridge tools). */
  allowedTools?: string;
  /** Pass additional MCP config entries if the test needs them. */
  extraMcpServers?: Record<string, unknown>;
}

export interface HeadlessResult {
  exitCode: number;
  /** The agent's final assistant message text (parsed from JSON output). */
  result: string;
  sessionId?: string;
  /** Reported cost — useful for logging and CI budgets. */
  totalCostUsd?: number;
  /** Full JSON response for debugging. */
  raw: string;
  /** Stderr from the claude process. */
  stderr: string;
}

/**
 * Spawn `claude -p` with the bridge wired as the only MCP server. Returns
 * the parsed JSON result plus the raw process output for debugging.
 */
export async function runClaudeHeadless(
  opts: HeadlessOptions
): Promise<HeadlessResult> {
  const configDir = mkdtempSync(join(tmpdir(), "bridge-mcp-cfg-"));
  const configFile = join(configDir, "mcp.json");

  const mcpServers = {
    "context-bridge": {
      command: process.execPath,
      args: [BRIDGE_DIST],
      env: { ECOSYSTEM_ROOT: opts.ecosystemRoot },
    },
    ...(opts.extraMcpServers ?? {}),
  };
  writeFileSync(configFile, JSON.stringify({ mcpServers }, null, 2), {
    encoding: "utf-8",
    // Restrict to owner-only — the file describes how to spawn the bridge
    // and (in future) might carry secrets via env. Not exploitable on
    // single-tenant CI runners but good hygiene on shared dev machines.
    mode: 0o600,
  });

  const args = [
    "-p",
    opts.prompt,
    "--mcp-config",
    configFile,
    "--strict-mcp-config",
    "--model",
    opts.model ?? DEFAULT_MODEL,
    "--allowedTools",
    opts.allowedTools ?? "mcp__context-bridge",
    "--output-format",
    "json",
    "--max-budget-usd",
    String(opts.maxBudgetUsd ?? DEFAULT_BUDGET_USD),
    "--permission-mode",
    "dontAsk",
    // NOTE: deliberately NOT passing --bare so the agent can authenticate
    // via the user's Claude Code subscription (OAuth from keychain or
    // CLAUDE_CODE_OAUTH_TOKEN). `--bare` would force ANTHROPIC_API_KEY.
  ];

  return new Promise((resolveP, reject) => {
    const proc = spawn("claude", args, {
      cwd: opts.cwd,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      rmSync(configDir, { recursive: true, force: true });
      try {
        const parsed = JSON.parse(stdout);
        resolveP({
          exitCode: code ?? 0,
          result: parsed.result ?? "",
          sessionId: parsed.session_id,
          totalCostUsd: parsed.total_cost_usd,
          raw: stdout,
          stderr,
        });
      } catch (e) {
        reject(
          new Error(
            `Failed to parse claude JSON output (exit ${code}):\n` +
              `stdout (last 500 chars): ${stdout.slice(-500)}\n` +
              `stderr (last 500 chars): ${stderr.slice(-500)}\n` +
              `original error: ${e}`
          )
        );
      }
    });
  });
}

/**
 * `describe.runIf` shorthand — only run a suite when the headless gate is on.
 * Auth itself is delegated to the `claude` CLI (OAuth subscription, OAuth
 * token, or API key — whichever it finds). If no auth is present, the
 * spawned `claude -p` call will fail with a clear error.
 */
export const headlessEnabled = process.env.RUN_E2E_HEADLESS === "1";
