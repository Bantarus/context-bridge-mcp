import { runCli } from "./cli.js";

// `beam` binary: the CLI only. `context-bridge-mcp <command>` does the same.
process.exitCode = await runCli(process.argv.slice(2));
