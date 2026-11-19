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

The server is a set of small modules under `src/`, using `@modelcontextprotocol/sdk` to expose 22 tools over stdio transport. There is no HTTP server, no database — just filesystem reads/writes against `.context/` directories, a shared `ecosystem.json`, an append-only `changelog.jsonl`, and the message bus under `<ECOSYSTEM_ROOT>/bus/`.

- `index.ts` — entry point and public exports. No arguments: MCP server (`mcp.ts`). With a subcommand: the CLI (`cli.ts`), also installed as the `beam` binary (`beam.ts`). The CLI path never imports the MCP SDK.
- Services: `config.ts` (all roots, from env + cwd; the CLI swaps it via `setConfig`), `errors.ts` (`BridgeError`; only `mcp.ts` maps it to `McpError`), `fsutil.ts`, `lock.ts`, `paths.ts`, `ecosystem.ts`, `manifest.ts`, `changelog.ts`, `contracts.ts`, `text.ts`, `skills.ts`, `redact.ts`, `identity.ts`.
- `tools/` — one file per tool group; `tools/index.ts` lists them in order. Bus tools are generated from `bus/ops.ts`.
- `bus/` — the communication layer (design: `docs/communication-layer-design.md`): `envelope.ts`, `transport.ts` (the `BusTransport` interface), `fs-transport.ts`, `state.ts`, `directory.ts`, `topics.ts`, `core.ts` (`Bus`), `render.ts`, `ops.ts` (the operation table both front ends are generated from).

**Key env vars:**
- `CONTEXT_ROOT` — path to the `.context/` directory. Defaults to `$CWD/.context`.
- `CONTRACTS_ROOT` — path to contracts. Defaults to `$CONTEXT_ROOT/contracts`. Can be overridden to point to a shared location.
- `ECOSYSTEM_ROOT` — path to the shared ecosystem registry. Defaults to `~/.context-bridge`. Contains `ecosystem.json` which tracks all registered repos.
- `WSL_DRIVES_ROOT` / `WSL_DISTROS_ROOT` — WSL only: where Windows drives (`/mnt`) and other distros' bind-mounted roots (`/mnt/wsl`) live. `WSL_DISTRO_NAME` (set by WSL) switches on WSL path translation.

**Boot behavior:** on startup the server creates `CONTEXT_ROOT` and `ECOSYSTEM_ROOT` if missing, and writes a default `manifest.json` (`{ "version": "1.0", "domains": {} }`) if one doesn't exist. This means a freshly-cloned repo gets a usable bridge state on the first MCP tool call without any setup.

**Concurrency:** all file writes are atomic (write-then-rename via `writeFileAtomic`, which retries `EPERM`/`EBUSY` renames on Windows/drvfs), so readers never see a torn file. Every `ecosystem.json` read-modify-write goes through `updateEcosystem()`, which re-reads under a cross-process `ecosystem.lock` — never write back an ecosystem snapshot read earlier. Locks are `withLock()` (O_EXCL lock file holding a random token; only the token holder removes it; a stale lock is broken only by whoever holds `<lock>.break`, so two waiters can't both break it). `updateManifest()` does the same for manifest edits that must not be lost. A malformed `ecosystem.json` throws instead of being treated as empty. The changelog uses append-safe `appendFile`; `bridge_changes` tracks a per-repo line cursor (`changelogCursor`) rather than timestamps, because entries come from processes on different clocks.

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
- `bridge_get_contract` / `bridge_update_contract` / `bridge_list_contracts` — read/write/list API contracts. `bridge_publish_contract` logs a contract edited in place. Contract and skill changelog entries carry `version`; summaries read `1.9 -> 1.10: <newest ## Changelog line>`, with the "from" side taken from the file being replaced or `lastLoggedVersion()` (the changelog, never the manifest). `bridge_get_contract` searches local repo first, then all ecosystem repos that expose "contracts". Automatically pins the consumed contract version in the ecosystem for drift detection
- `bridge_changes` — show open messages (from the bus, not consumed), changes from other repos, and contract/skill version drift. Compares consumed versions (pinned by `bridge_get_contract`) against current versions. Changelog entries are matched as automatic topics (`<repo>/contracts/<domain>`, `<repo>/skills/<name>`, `<repo>/context/<domain>`, `<repo>/manifest`) against the repo's subscriptions: manifest `subscriptions`, `watches` (mapped by `watchesToPatterns`, same matches as before minus messages), defaults to `*/contracts/*` when neither is set, and always installed skills and `ecosystem/announce`. Mutation tools (`bridge_update`, `bridge_update_contract`, `bridge_manifest_update`) automatically append to `changelog.jsonl`
- `bridge_sync_skills` — install/update companion skills (context-reader, context-feeder, context-bridge) into the current repo's `.claude/skills/`, and refresh every skill listed in the manifest's `installedSkills` from its provider
- `bridge_install_skill` / `bridge_uninstall_skill` — copy a skill another ecosystem repo publishes (`<repo>/.context/skills/<name>/`, repo must expose "skills") into `<cwd>/.claude/skills/<name>/`, recorded as `installedSkills.<name> = { from, version }`; uninstall removes both. Byte-for-byte copy, symlinks skipped, nothing executed; never touches a skill folder the bridge didn't install unless `force`
- `bridge_publish_skill` — provider side: record `skills.<name>.version` (from SKILL.md `metadata.version`) in the manifest and log a `type: "skill"` changelog entry when it differs from the last *published* (logged) version. `bridge_manifest_update` also logs skill version changes. `bridge_discover` lists published skills; `bridge_changes` reports installed-skill drift and always shows updates to installed skills

- `bridge_inbox` / `bridge_send` / `bridge_ack` / `bridge_subscribe` — the message bus, generated from `src/bus/ops.ts` (the `beam` CLI exposes the same operations: `inbox`, `read`, `thread`, `send`, `ack`, `subscribe`). Mailbox = repo; identity is the ecosystem entry whose registered path is this repo (`findRepoByPath`), so unregistered repos can't use the bus. Storage: one append-only log per author (`bus/log/<repo>/NNNNNN.jsonl`, single writer), immutable bodies (`bus/log/<repo>/body/<id>.md`), per-repo state (`bus/state/<repo>.json`: opaque cursor, inbox, sent, feed), and `bus/directory/<repo>.json` (declared topics and `messaging` rules, published by the repo's own sessions so others never read its manifest). Messages stay open until acked; receipts flow back to the sender. Pull only: nothing is pushed, and the layer sets no rules for how agents use it. Old `type: "message"` changelog lines are imported as `legacy-<line>` inbox items. Lock order is always state, then author log
- `bridge_send_message` — deprecated alias of `bridge_send` (a `note`); an old `inReplyTo: "<repo>/requests/<file>"` maps to the matching legacy item
- `bridge_manifest` and `bridge_discover` append a `registrationNotice()` warning when the current repo isn't in the ecosystem (or is registered under a different name than its manifest `project`)

### Security

`assertSafePath()` validates that all resolved file paths stay within allowed roots (`CONTEXT_ROOT`, `CONTRACTS_ROOT`, or an explicit external root for `bridge_get_from`) to prevent path traversal. It rejects `..` escapes and cross-drive (absolute) relatives. Every tool that takes a `domain`/`component` must call it — including listing tools.

**No path leaks:** tool output must never reveal another registered repo's absolute path (an agent could use it to bypass the bridge with its own file tools). The `CallToolRequestSchema` handler wraps `handleToolCall()` and runs every response block and every error message through `buildPathRedactor()`, which replaces each registered repo's path (stored and local notations, either slash direction, case-insensitive, JSON-escaped) with `<repo:name>` and `ECOSYSTEM_ROOT` with `<ECOSYSTEM_ROOT>`; the current repo's own path is exempt. Blocks that carry a repo's own document (context file, contract, manifest, `bridge_discover` detail) are marked `verbatim: true` and pass through unchanged — redact any bridge-generated field inside them explicitly. Don't put paths in bridge messages in the first place: errors from `toLocalPath()` / `resolveStoredDir()` say *why* a repo is unreachable, not where it is.

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
