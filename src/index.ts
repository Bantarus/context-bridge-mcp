import { realpathSync } from "fs";
import { fileURLToPath } from "url";

// ─── Public API (library and tests) ──────────────────────────────────────────

export { writeFileAtomic } from "./fsutil.js";
export {
  assertSafePath,
  currentPathEnv,
  parseAnyPath,
  toCanonicalPath,
  toLocalPath,
  type PathEnv,
  type LocalPathResult,
} from "./paths.js";
export { parseSkillFrontmatter } from "./skills.js";
export { entryVersion, watchMatchesEntry } from "./changelog.js";
export {
  extractVersion,
  extractSummary,
  extractNewestChangelogLine,
  contractSummary,
} from "./text.js";
export { buildPathRedactor } from "./redact.js";
export { deepMerge } from "./manifest.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────
//
// No arguments: run the MCP server on stdio (how clients launch it). With a
// subcommand: run one CLI operation and exit. Each path loads only what it
// needs — the CLI never imports the MCP SDK.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const { runCli } = await import("./cli.js");
    process.exitCode = await runCli(args);
    return;
  }
  const { runServer } = await import("./mcp.js");
  await runServer();
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
