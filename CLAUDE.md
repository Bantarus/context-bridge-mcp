# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Context Bridge MCP is a lightweight, project-agnostic MCP (Model Context Protocol) server. It acts as a stateless I/O tool that reads and writes `.context/` folders in whatever repo it is invoked from. Each repo declares its own domains via a `manifest.json` — the server has zero project-specific knowledge.

## Build and run

```bash
npm install
npm run build          # tsc -> dist/
npm start              # node dist/index.js
npm run dev            # tsx watch (no build step, live reload)
```

The project uses ESM (`"type": "module"`) with `tsconfig.json` targeting ES2022 / Node16 module resolution.

## Architecture

The entire server is a single file: `src/index.ts`. It uses the `@modelcontextprotocol/sdk` to expose 13 tools over stdio transport. There is no HTTP server, no database — just filesystem reads/writes against `.context/` directories, a shared `ecosystem.json`, and an append-only `changelog.jsonl`.

**Key env vars:**
- `CONTEXT_ROOT` — path to the `.context/` directory. Defaults to `$CWD/.context`.
- `CONTRACTS_ROOT` — path to contracts. Defaults to `$CONTEXT_ROOT/contracts`. Can be overridden to point to a shared location.
- `ECOSYSTEM_ROOT` — path to the shared ecosystem registry. Defaults to `~/.context-bridge`. Contains `ecosystem.json` which tracks all registered repos.
- `WSL_DRIVES_ROOT` / `WSL_DISTROS_ROOT` — WSL only: where Windows drives (`/mnt`) and other distros' bind-mounted roots (`/mnt/wsl`) live. `WSL_DISTRO_NAME` (set by WSL) switches on WSL path translation.

**Boot behavior:** on startup the server creates `CONTEXT_ROOT` and `ECOSYSTEM_ROOT` if missing, and writes a default `manifest.json` (`{ "version": "1.0", "domains": {} }`) if one doesn't exist. This means a freshly-cloned repo gets a usable bridge state on the first MCP tool call without any setup.

**Concurrency:** all file writes are atomic (write-then-rename via `writeFileAtomic`, which retries `EPERM`/`EBUSY` renames on Windows/drvfs), so readers never see a torn file. Every `ecosystem.json` read-modify-write goes through `updateEcosystem()`, which re-reads under a cross-process `ecosystem.lock` (O_EXCL lock file) — never write back an ecosystem snapshot read earlier. A malformed `ecosystem.json` throws instead of being treated as empty. The changelog uses append-safe `appendFile`; `bridge_changes` tracks a per-repo line cursor (`changelogCursor`) rather than timestamps, because entries come from processes on different clocks.

**Cross-environment paths:** one ecosystem can be shared by bridges on Windows and in several WSL distros. `bridge_register` stores paths in canonical Windows notation (`C:\...`, `\\wsl.localhost\<Distro>\...`) via `toCanonicalPath()`; every read goes through `toLocalPath()` / `repoRoot()` / `repoContractsDir()`, which translate to the local view and return an explanatory error when a repo is unreachable. Never `resolve(entry.path)` directly. Entries may also carry `contractsPath` when contracts live outside `<repo>/.context/contracts`.

### `.context/` directory structure

```
.context/
  manifest.json          <- registry of domains and components
  contracts/             <- API contracts (inter-repo boundaries)
  api/                   <- example domain
  schemas/               <- example domain
  events/                <- example domain
```

### Tools exposed

- `bridge_manifest` / `bridge_manifest_update` — read/patch the manifest registry
- `bridge_get` / `bridge_update` — read/write context files at `.context/<domain>/<component>.md`
- `bridge_list` — discover existing context files with optional domain filter
- `bridge_get_from` — read context files from another repo's `.context/` by path
- `bridge_register` / `bridge_discover` — register repos in the ecosystem and discover them
- `bridge_get_contract` / `bridge_update_contract` / `bridge_list_contracts` — read/write/list API contracts. `bridge_get_contract` searches local repo first, then all ecosystem repos that expose "contracts". Automatically pins the consumed contract version in the ecosystem for drift detection
- `bridge_changes` — show changes from other repos and detect contract version drift. Compares consumed versions (pinned by `bridge_get_contract`) against current versions. Also shows changelog entries filtered by `watches` in manifest. Mutation tools (`bridge_update`, `bridge_update_contract`, `bridge_manifest_update`) automatically append to `changelog.jsonl`
- `bridge_sync_skills` — install/update companion skills (context-reader, context-feeder, context-bridge) into the current repo's `.claude/skills/`

### Security

`assertSafePath()` validates that all resolved file paths stay within allowed roots (`CONTEXT_ROOT`, `CONTRACTS_ROOT`, or an explicit external root for `bridge_get_from`) to prevent path traversal. It rejects `..` escapes and cross-drive (absolute) relatives. Every tool that takes a `domain`/`component` must call it — including listing tools.

### Deep merge

`bridge_manifest_update` uses a custom `deepMerge()` that recursively merges objects but replaces arrays wholesale (does not concatenate them).

## IMPORTANT: Keep companion skills in sync

When you modify the MCP server (tool signatures, tool names, path resolution, manifest format, or any behavioral change), you MUST also update the companion skills that depend on it:

- `.claude/skills/context-reader/` — reads `.context/` at session start; must match current tool names and parameters
- `.claude/skills/context-feeder/` — writes `.context/` after implementing; must match current tool names, parameters, and file format conventions
- `.claude/skills/context-bridge/` — cross-repo coordination guide; must match tool names, ecosystem workflow, and onboarding steps

If a tool is added, removed, or has its schema changed, all three skills need to reflect that. Stale skills will generate incorrect tool calls and silently fail.

## Companion files

- `CONTEXT.md.template` — generic skill file template that projects copy into their `.context/CONTEXT.md`
- `claude.json.example` — template for connecting repos to this MCP server
