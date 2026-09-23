/**
 * Spawn the compiled context-bridge MCP server as a child process and
 * connect a real MCP client to it over stdio. This is the integration-level
 * harness: it tests the actual binary that gets shipped, not a mocked
 * in-process variant.
 *
 * Usage in a test file:
 *
 *   import { startBridge, getToolText, BridgeHandle } from "../helpers/bridge-server.js";
 *
 *   describe("bridge_manifest", () => {
 *     let bridge: BridgeHandle;
 *     beforeAll(async () => { bridge = await startBridge(); });
 *     afterAll(async () => { await bridge.close(); });
 *     beforeEach(() => { bridge.resetState(); });
 *
 *     it("returns the default manifest after reset", async () => {
 *       const result = await bridge.client.callTool({ name: "bridge_manifest", arguments: {} });
 *       expect(getToolText(result)).toContain('"version": "1.0"');
 *     });
 *   });
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIST = resolve(__dirname, "../../dist/index.js");

const DEFAULT_MANIFEST = { version: "1.0", domains: {} };

export interface BridgeHandle {
  client: Client;
  /** Absolute path the spawned bridge uses as CONTEXT_ROOT. */
  ctxRoot: string;
  /** Absolute path the spawned bridge uses as ECOSYSTEM_ROOT. */
  ecoRoot: string;
  /** Absolute path the spawned bridge uses as its cwd. */
  cwd: string;
  /**
   * Wipe the per-test state directories and recreate them with a default
   * manifest, mirroring the server's boot-time initialization. Call this in
   * `beforeEach` to give each test a clean slate without restarting the
   * server.
   */
  resetState: () => void;
  /** Kill the server, close transport, and clean tmp dirs. */
  close: () => Promise<void>;
}

export interface StartBridgeOptions {
  /**
   * Additional env vars to pass to the spawned bridge. Useful for setting
   * `CONTRACTS_ROOT` to a shared directory across multiple bridge instances
   * in multi-repo scenario tests.
   */
  env?: Record<string, string>;
  /**
   * Override the spawned bridge's cwd. Defaults to the per-test tmp dir.
   * Some tests (e.g. `currentRepoName` resolution) need a controlled cwd.
   */
  cwd?: string;
}

export async function startBridge(
  options: StartBridgeOptions = {}
): Promise<BridgeHandle> {
  const tmp = mkdtempSync(join(tmpdir(), "bridge-int-"));
  const ctxRoot = join(tmp, "context");
  const ecoRoot = join(tmp, "ecosystem");
  const cwd = options.cwd ?? tmp;
  mkdirSync(ctxRoot, { recursive: true });
  mkdirSync(ecoRoot, { recursive: true });
  // Seed default manifest so the first read doesn't hit the {} fallback path
  writeFileSync(
    join(ctxRoot, "manifest.json"),
    JSON.stringify(DEFAULT_MANIFEST, null, 2),
    "utf-8"
  );

  // Run as plain Linux regardless of where the suite runs: inside WSL the
  // bridge would otherwise canonicalize registered paths to
  // \\wsl.localhost\<distro>\... and diverge from CI. WSL behavior is
  // covered by tests that set WSL_DISTRO_NAME explicitly.
  const { WSL_DISTRO_NAME: _wslDistro, ...parentEnv } =
    process.env as Record<string, string>;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE_DIST],
    env: {
      ...parentEnv,
      CONTEXT_ROOT: ctxRoot,
      ECOSYSTEM_ROOT: ecoRoot,
      ...(options.env ?? {}),
    },
    cwd,
  });

  const client = new Client(
    { name: "bridge-integration-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  const handle: BridgeHandle = {
    client,
    ctxRoot,
    ecoRoot,
    cwd,
    resetState: () => {
      rmSync(ctxRoot, { recursive: true, force: true });
      rmSync(ecoRoot, { recursive: true, force: true });
      // Also wipe anything the bridge wrote into the cwd (e.g. .claude/skills
      // from bridge_sync_skills) so tests don't leak state between cases.
      rmSync(join(cwd, ".claude"), { recursive: true, force: true });
      mkdirSync(ctxRoot, { recursive: true });
      mkdirSync(ecoRoot, { recursive: true });
      writeFileSync(
        join(ctxRoot, "manifest.json"),
        JSON.stringify(DEFAULT_MANIFEST, null, 2),
        "utf-8"
      );
    },
    close: async () => {
      await client.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };

  return handle;
}

/**
 * Pull the first text block out of an MCP tool-call result. The bridge
 * server only ever returns text content, so this is the canonical accessor
 * for integration assertions.
 */
export function getToolText(result: unknown): string {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (!r.content || r.content.length === 0) {
    throw new Error("Tool result has no content blocks");
  }
  const block = r.content[0];
  if (block.type !== "text" || typeof block.text !== "string") {
    throw new Error(`Expected text content, got ${block.type}`);
  }
  return block.text;
}

/**
 * Get all text blocks concatenated. Some bridge tools (e.g.
 * `bridge_get_contract`) return multiple text blocks — one for the
 * "resolved from ecosystem" header and one for the actual content.
 */
export function getAllToolText(result: unknown): string[] {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r.content) return [];
  return r.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
}
