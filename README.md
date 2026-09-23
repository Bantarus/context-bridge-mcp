# Context Bridge MCP

[![CI](https://github.com/Bantarus/context-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Bantarus/context-bridge-mcp/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/Bantarus/context-bridge-mcp?display_name=tag&sort=semver)](https://github.com/Bantarus/context-bridge-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-blue.svg)](https://nodejs.org/)

A lightweight, project-agnostic MCP server that gives Claude Code agents shared
context across multiple repos on the same machine. Each repo owns its own
`.context/` folder — the server is a stateless I/O tool with zero project knowledge.

---

## Install

Three install paths depending on your use case:

### A. `.mcpb` bundle (one-click install in Claude Desktop and other MCPB-aware hosts)

Download the latest `.mcpb` from the
[GitHub Releases page](https://github.com/Bantarus/context-bridge-mcp/releases/latest),
or build one from source:

```bash
npm install
npm run release:mcpb
# Produces: context-bridge-mcp.mcpb
```

Then drag the `.mcpb` file into Claude Desktop (or any host that implements the
[MCPB spec](https://github.com/modelcontextprotocol/mcpb)). The host will prompt
for the **Ecosystem Root** (defaults to `~/.context-bridge`) and wire everything
up. No manual config.

### B. Claude Code CLI (manual stdio registration)

```bash
npm install
npm run build
```

Register once at user scope so it works in every repo automatically:

```bash
claude mcp add --scope user --transport stdio context-bridge \
  -- node /absolute/path/to/context-bridge-mcp/dist/index.js
```

Optional: override the contracts directory for a shared location:

```bash
claude mcp add --scope user --transport stdio context-bridge \
  --env CONTRACTS_ROOT=/absolute/path/to/shared-contracts \
  -- node /absolute/path/to/context-bridge-mcp/dist/index.js
```

(`--env` must come before `--`; anything after it is passed to `node`.)

Or use `claude.json.example` as a template for per-repo configuration.

**Additional WSL distros** don't need their own clone. Once the distro that
holds the build is bind-mounted under `/mnt/wsl/<Distro>` (see
[WSL + Windows cross-environment usage](#wsl--windows-cross-environment-usage)),
register that same build from the other distro:

```bash
# Inside e.g. Ubuntu-24.04, as the user who runs Claude Code
claude mcp add --scope user --transport stdio context-bridge \
  --env ECOSYSTEM_ROOT=/mnt/c/Users/you/.context-bridge \
  -- node /mnt/wsl/Ubuntu/home/you/DEV/context-bridge-mcp/dist/index.js
```

### C. Embed in a host application (Electron operator gateway, IDE plugin, etc.)

Context Bridge is **not** published to npm — install it directly from this
GitHub repo:

```bash
npm install github:Bantarus/context-bridge-mcp
# Or pin to a specific release tag:
npm install github:Bantarus/context-bridge-mcp#v1.0.0
```

npm runs the `prepare` script after install, which builds `dist/` for you.

See [Embedding in a host application](#embedding-in-a-host-application) below for
the spawn pattern.

---

## How it works

The server reads and writes `.context/` folders relative to the working directory
of the process that invokes it (typically the repo root where Claude Code is running).

Each repo is self-describing via a `manifest.json` in its `.context/` folder.
The server trusts that manifest — it does not enforce any schema or naming.

Cross-repo access is explicit via `bridge_get_from`, which takes a path to
another repo and reads its `.context/` folder.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_ROOT` | `$CWD/.context` | Path to the context directory |
| `CONTRACTS_ROOT` | `$CONTEXT_ROOT/contracts` | Path to contracts (can be shared across repos) |
| `ECOSYSTEM_ROOT` | `~/.context-bridge` | Path to the shared ecosystem registry |
| `WSL_DRIVES_ROOT` | `/mnt` | (WSL only) where Windows drives are mounted — match `automount.root` in `/etc/wsl.conf` |
| `WSL_DISTROS_ROOT` | `/mnt/wsl` | (WSL only) where other WSL distros' filesystems are bind-mounted |

---

## Tools

| Tool | Description |
|------|-------------|
| `bridge_manifest` | Full registry — call first every session |
| `bridge_get` | Fetch one context file by domain/component |
| `bridge_update` | Write a context file after implementing |
| `bridge_list` | Discover existing files, optionally filtered by domain |
| `bridge_get_from` | Fetch a context file from another repo by path |
| `bridge_register` | Register a repo in the shared ecosystem |
| `bridge_discover` | List or inspect repos in the ecosystem |
| `bridge_get_contract` | Fetch a contract — searches local then ecosystem |
| `bridge_update_contract` | Write a contract file |
| `bridge_list_contracts` | List all contracts |
| `bridge_changes` | Show changes from other repos since last check |
| `bridge_sync_skills` | Install/update companion skills into current repo |
| `bridge_manifest_update` | Deep-merge a patch into manifest.json |

---

## `.context/` directory layout

Each repo that uses the bridge creates this structure:

```
your-repo/
  .context/
    manifest.json          <- registry of domains and components
    contracts/             <- API contracts (inter-repo boundaries)
      users.md
      billing.md
    api/                   <- example domain
      routes.md
      middleware.md
    schemas/               <- example domain
      user.md
      session.md
    events/                <- example domain
      user-events.md
```

---

## Getting started in a new repo

1. Copy `CONTEXT.md.template` to `<your-repo>/.context/CONTEXT.md` and fill it in
2. Create your first context file and manifest:

```bash
mkdir -p .context/api
echo '{"version":"1.0","domains":{"api":["routes"]}}' > .context/manifest.json
```

3. Install the companion skills into the repo:

```
bridge_sync_skills()
```

This copies `context-reader`, `context-feeder`, and `context-bridge` skills
into `.claude/skills/` so Claude Code knows how to use the bridge automatically.

4. Start using the bridge tools in Claude Code — call `bridge_manifest()` first

---

## Usage guide

### The problem this solves

When Claude Code works in one repo, it has no idea what exists in related repos.
If your frontend calls an API, Claude Code in the frontend repo doesn't know the
endpoint signatures, event shapes, or data models from the backend. Loading the
entire backend codebase into context is wasteful and noisy.

The bridge solves this by giving each repo a small `.context/` folder that
describes its architecture in plain markdown. Claude Code reads only the context
files relevant to the current task — not the full codebase of every repo.

### Core workflow

**1. Set up each repo once**

Create a `.context/` folder with a manifest and context files that describe
your repo's architecture. You don't need to document everything — start with
the parts that other repos interact with.

```
my-api/
  .context/
    manifest.json
    routes/
      users.md        ← describes the /users endpoints
      billing.md      ← describes the /billing endpoints
    schemas/
      user.md         ← describes the User data model
    contracts/
      users.md        ← the agreed API contract other repos depend on
```

```
my-frontend/
  .context/
    manifest.json
    pages/
      dashboard.md    ← describes what data the dashboard needs
      settings.md
    contracts/
      users.md        ← same contract, from the consumer's perspective
```

The manifest is a simple registry:

```json
{
  "version": "1.0",
  "domains": {
    "routes": ["users", "billing"],
    "schemas": ["user"],
  }
}
```

**2. Register each repo in the ecosystem**

Each repo declares its existence once so other repos can discover it automatically:

```
bridge_register({
  name: "my-api",
  path: "/absolute/path/to/my-api",
  exposes: ["routes", "schemas", "contracts"],
  stack: "Node.js / Express"
})
```

```
bridge_register({
  name: "my-frontend",
  path: "/absolute/path/to/my-frontend",
  exposes: ["contracts"],
  stack: "React / TypeScript"
})
```

This writes to a shared `ecosystem.json` at `~/.context-bridge/`. All repos
on the machine can see each other without hardcoded paths.

**3. Claude Code reads context at the start of a session**

When you start working, Claude Code orients itself, checks for changes, then
fetches only the context relevant to the task:

```
bridge_manifest()              ← what domains does this repo have?
bridge_discover()              ← what other repos exist in the ecosystem?
bridge_changes()               ← what changed in other repos since last session?
bridge_get("routes", "users")  ← fetch the context I need
bridge_get_contract("users")   ← resolved automatically from ecosystem
```

`bridge_changes` is filtered by `watches` in your manifest. If you declare
watches, you only see changes from the repos and domains you care about:

```json
{
  "watches": {
    "my-api": ["contracts", "schemas"],
    "shared-lib": ["events"]
  }
}
```

Each watch token matches in two ways:

- **Category keyword** — `"contracts"` matches all contract changes,
  `"context"` matches all context changes, `"manifests"` matches manifest
  changes. Both singular (`"contract"`) and plural (`"contracts"`) forms
  work, case-insensitive.
- **Specific domain name** — `"schemas"` matches changes whose domain is
  `schemas` (typically context files under `.context/schemas/`); `"users"`
  matches the `users` contract or any domain literally named `users`.

The example above subscribes to *all* of `my-api`'s contracts plus changes
in its `schemas` domain, and to anything in `shared-lib`'s `events` domain.

If no watches are declared, `bridge_changes` shows all contract changes from
other repos as a safe default.

`bridge_get_contract` is ecosystem-aware: it searches the current repo first,
then all ecosystem repos that expose `contracts`. No need to know which repo
owns a contract.

**4. Claude Code reads from other repos when needed**

For internal context (not contracts), Claude Code can read another repo
directly via path or by discovering it first:

```
bridge_discover("my-api")                          ← get path and details
bridge_get_from("/path/to/my-api", "routes", "users")  ← read internal context
```

This is read-only — Claude Code never writes to another repo's context.

**5. Claude Code writes back after implementing**

After making changes, Claude Code updates the context files so they stay in
sync with the actual code. This is the most important step — stale context is
worse than no context.

```
bridge_update("routes", "users", "# Users Routes\n\n## Purpose\n...")
bridge_manifest_update({ "patch": { "domains": { "routes": ["users", "billing", "auth"] } } })
```

### Contracts vs context files

- **Context files** (`.context/<domain>/<component>.md`) describe internal
  architecture. They help Claude Code understand your repo. Other repos *can*
  read them via `bridge_get_from`, but they're not designed as a stable interface.

- **Contracts** (`.context/contracts/<domain>.md`) define the agreed boundary
  between repos — endpoints, event shapes, shared types. They are the only
  thing another repo should rely on. When a contract changes, both sides need
  to update.

### When to use `bridge_get_from` vs contracts

| Situation | Use |
|-----------|-----|
| Need to know another repo's API shape | `bridge_get_contract` (read the contract) |
| Debugging a mismatch between repos | `bridge_get_from` (peek at their internals) |
| Implementing against a stable interface | `bridge_get_contract` |
| Understanding how another repo works internally | `bridge_get_from` |

### Contract version tracking

Every contract must have a `## Version` section:

```markdown
# Contract: users

## Version
2.1

## Changelog
- 2026-04-21: Added rate limit header
- 2026-04-15: Initial contract
```

When a repo reads a contract via `bridge_get_contract`, the bridge automatically
pins the consumed version in the ecosystem. On the next session start,
`bridge_changes` compares the pinned version against the current version and
warns about drift:

```
Version drift detected (1):

  ⚠ contract "users": you consumed v2.0 from my-api on 2026-04-15, current is v2.1
```

This means the agent knows exactly what changed and can re-fetch the contract
to understand the delta before writing any code against a stale interface.

### Tips

- **Start small.** You don't need to document every file. Begin with the
  components that cross repo boundaries, then expand as needed.
- **Contracts are the source of truth.** If a contract and a context file
  disagree, the contract wins.
- **Keep context files short.** A few paragraphs per component is ideal.
  If a file is getting long, split it into multiple components.
- **Automate the write-back.** Use the `context-feeder` skill to automatically
  update context files after implementing. Context drift is the main failure
  mode of the bridge pattern.

---

## WSL + Windows cross-environment usage

One ecosystem can span the Windows host and any number of WSL2 distros. Each
environment runs its own bridge process; they share a single
`ecosystem.json` and translate paths to their own view of the filesystem.

**1. Point every environment at the same `ECOSYSTEM_ROOT`** on the Windows
drive, the only location all of them can reach:

```bash
# In each WSL distro (e.g. Ubuntu and Ubuntu-24.04)
claude mcp add --scope user --transport stdio context-bridge \
  --env ECOSYSTEM_ROOT=/mnt/c/Users/you/.context-bridge \
  -- node /path/to/context-bridge-mcp/dist/index.js
```

```powershell
# On Windows
claude mcp add --scope user --transport stdio context-bridge `
  --env ECOSYSTEM_ROOT=C:\Users\you\.context-bridge `
  -- node C:\path\to\context-bridge-mcp\dist\index.js
```

**2. Register repos with any absolute path.** `bridge_register` accepts
`/home/...`, `/mnt/c/...`, `C:\...` or `\\wsl.localhost\<Distro>\...` and
stores it in Windows notation, which every environment can translate:

| Registered from | You pass | Stored as |
|---|---|---|
| WSL `Ubuntu` | `/home/you/api` | `\\wsl.localhost\Ubuntu\home\you\api` |
| WSL `Ubuntu` | `/mnt/c/Users/you/Client` | `C:\Users\you\Client` |
| Windows | `C:\Users\you\Client` | `C:\Users\you\Client` |

When reading, a WSL bridge maps `C:\...` to `/mnt/c/...` and its own distro's
UNC path back to `/...`; a Windows bridge uses the stored path directly.

**3. For WSL ↔ WSL, expose each distro's filesystem to the others.** Distros
cannot see each other's files by default. `/mnt/wsl` is shared by all
distros, so bind-mount each distro's root there — inside that distro's
`/etc/wsl.conf`:

```ini
[boot]
command = mkdir -p /mnt/wsl/Ubuntu-24.04 && mount --bind / /mnt/wsl/Ubuntu-24.04
```

(use the distro's own name; takes effect after `wsl --shutdown`). A bridge in
`Ubuntu` then reads `\\wsl.localhost\Ubuntu-24.04\...` via
`/mnt/wsl/Ubuntu-24.04/...`. If the mount is missing, tools say so and print
the command to run instead of failing silently.

**Notes:**

- `bridge_discover` flags repos that are unreachable from the current
  environment; `bridge_get_contract` lists them alongside "not found".
- Entries written by older versions as plain Linux paths still work inside
  the distro that wrote them. Re-run `bridge_register` for them (from that
  distro) so Windows and other distros can resolve them too.
- `bridge_changes` tracks its position in `changelog.jsonl` by line, not by
  timestamp, so a WSL2 clock that lags the host after sleep never hides
  entries.
- Concurrent writes to `ecosystem.json` from all environments are serialized
  with a lock file (`ecosystem.lock`); if a crashed process leaves one
  behind, it is considered stale after 30 s.
- `/mnt/c` and `\\wsl.localhost` access is slower than native filesystem
  access; keep each repo on the side where you edit it most.

---

## Embedding in a host application

Context Bridge MCP can be embedded as a child process inside any host that
speaks MCP — Electron operator gateways, IDE plugins, custom orchestrators.
This is the same pattern Claude Code, Cursor, Continue, and Zed use for
native MCPs.

### Install

Either depend on it via npm:

```bash
npm install context-bridge-mcp
```

Or bundle the compiled `dist/` folder directly with your app's resources.

### Spawn pattern (with `@modelcontextprotocol/sdk`)

The cleanest path is to let the MCP SDK manage the child process via
`StdioClientTransport`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { app } from "electron";
import { resolve } from "node:path";

// Resolve to the bundled or installed binary
const binary = resolve(
  app.getAppPath(),
  "node_modules/context-bridge-mcp/dist/index.js"
);

const transport = new StdioClientTransport({
  command: process.execPath,        // Electron's bundled Node
  args: [binary],
  env: {
    ...process.env,
    // Persistent state under the host's user data dir
    ECOSYSTEM_ROOT: resolve(app.getPath("userData"), "context-bridge"),
    // Override per active workspace if needed
    CONTEXT_ROOT: resolve(activeRepoPath, ".context"),
  },
  cwd: activeRepoPath,              // .context/ is read from cwd by default
});

const client = new Client({ name: "operator-gateway", version: "1.0.0" }, {});
await client.connect(transport);

// Now call tools
const manifest = await client.callTool({ name: "bridge_manifest", arguments: {} });
```

### Manual spawn (full lifecycle control)

If you need to manage the process yourself (custom restart logic,
crash supervision, log capture):

```ts
import { spawn } from "node:child_process";

const proc = spawn(process.execPath, [binary], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: activeRepoPath,
  env: {
    ...process.env,
    ECOSYSTEM_ROOT: resolve(app.getPath("userData"), "context-bridge"),
  },
});

proc.stderr.on("data", (chunk) => {
  // Server logs (boot info, warnings) go to stderr
  console.log("[context-bridge]", chunk.toString());
});

// Wire proc.stdin / proc.stdout to your MCP client transport
// Handle proc.on("exit", ...) for restart logic
// Call proc.kill() in app.on("before-quit", ...)
```

### Environment variables an embedding host should set

| Var | Purpose | Recommended value |
|-----|---------|-------------------|
| `ECOSYSTEM_ROOT` | Where `ecosystem.json` and `changelog.jsonl` live | `app.getPath("userData") + "/context-bridge"` (or shared across all your app instances) |
| `CONTEXT_ROOT` | Override the `.context/` location | Usually unset — `process.cwd() + "/.context"` is correct when you set `cwd` |
| `CONTRACTS_ROOT` | Override contracts location | Set if you want a shared contracts folder across multiple repos |

### Switching active workspaces

The bridge resolves `.context/` from `process.cwd()`. To switch active
workspaces in your host app, you have two options:

1. **Restart the child process** with a new `cwd` — clean state, simple,
   takes ~50ms. Recommended for most operator gateways.
2. **Set `CONTEXT_ROOT` per-call via env** — not currently supported, would
   require an architectural change to make the tools accept a workspace
   argument.

### Cross-platform notes

- Use `process.execPath` rather than `"node"` so you get the Electron-bundled
  Node runtime (no system Node dependency for end users)
- On Windows, `node_modules/.bin/context-bridge-mcp` resolves to a `.cmd`
  shim — prefer the direct path to `dist/index.js` for spawning
- The shebang line works on POSIX systems if you mark the file executable
  (npm install does this automatically via the `bin` field)

---

## Building the `.mcpb` bundle

Context Bridge ships an [MCPB manifest](https://github.com/modelcontextprotocol/mcpb)
at the repo root (`manifest.json`) so it can be packaged as a single `.mcpb` file
for one-click install in Claude Desktop and other MCPB-aware hosts.

```bash
# Validate the manifest
npm run validate:mcpb

# Build a quick bundle (uses your current node_modules — may include devDeps)
npm run pack:mcpb

# Build a release bundle (production-only deps, ~2.5 MB)
npm run release:mcpb
```

The release script reinstalls deps as production-only, builds, packs, then
restores your dev environment. Output: `context-bridge-mcp.mcpb` at the repo root.

**Note:** The MCPB `manifest.json` at the repo root is unrelated to the bridge's
own `.context/manifest.json` per-repo registry — they describe different things
in different scopes.

---

## Optional: Docker deployment (for organizations)

Individual developers should use the `.mcpb` bundle above. The Docker path is
for **organizations** that have standardized on Docker MCP Gateway, want to
distribute through a private OCI registry, or need supply-chain governance
(signing, SBOMs, central allowlists). The repo includes three reference files
under [docker/](docker/) as starting points for your platform team to adapt —
context-bridge does **not** publish or maintain its own Docker images.

### Reference files

| File | Purpose |
|------|---------|
| [docker/Dockerfile.example](docker/Dockerfile.example) | Multi-stage build, ~80 MB alpine image, dist/ + companion skills |
| [docker/catalog-entry.example.yaml](docker/catalog-entry.example.yaml) | Minimal `server.yaml` for `docker mcp catalog server add` or `profile server add` |
| [docker/.dockerignore.example](docker/.dockerignore.example) | Copy to repo root before building to shrink build context |

### Build and tag

```bash
cp docker/.dockerignore.example .dockerignore
docker build -f docker/Dockerfile.example \
  -t registry.internal.corp/mcp/context-bridge:1.0.0 .
docker push registry.internal.corp/mcp/context-bridge:1.0.0
```

### Run directly via `docker run` (portable, no gateway required)

Context Bridge is a **filesystem orchestrator**: it must see the active repo
and the shared ecosystem directory. The MCP client speaks stdio over
`docker run -i`:

```bash
docker run -i --rm \
  -v "$PWD:/workspace" \
  -v "$HOME/.context-bridge:/ecosystem" \
  -e ECOSYSTEM_ROOT=/ecosystem \
  -w /workspace \
  registry.internal.corp/mcp/context-bridge:1.0.0
```

| Flag | Why |
|------|-----|
| `-i` | stdio transport — keep stdin open |
| `-v "$PWD:/workspace"` | the bridge reads `.context/` from the **active repo** |
| `-v "$HOME/.context-bridge:/ecosystem"` | shared ecosystem registry must persist across runs |
| `-e ECOSYSTEM_ROOT=/ecosystem` | tells the bridge where the ecosystem lives inside the container |
| `-w /workspace` | sets `process.cwd()` so the default `CONTEXT_ROOT` resolves correctly |

**Caveat:** when registering with `claude mcp add`, the bind-mount path is
fixed at registration time. If you `cd` into a different repo, the container
will still see whichever directory you registered. Solutions:

- Use the **MCPB bundle** instead (recommended for the common per-repo workflow)
- Register the server **per-repo** with a wrapper script that resolves `$PWD`
- Use **Docker MCP Gateway** (next section) which manages per-session mounts

### Run via Docker MCP Gateway (centralized governance)

Add the server to a private custom catalog and distribute it to your team:

```bash
# Platform team — build the catalog once
docker mcp catalog create registry.internal.corp/mcp/team-catalog:latest \
  --title "Internal MCP Tools" \
  --server file://./docker/catalog-entry.example.yaml \
  --server docker://registry.internal.corp/mcp/internal-api:latest

docker mcp catalog push registry.internal.corp/mcp/team-catalog:latest

# Individual developers
docker mcp catalog pull registry.internal.corp/mcp/team-catalog:latest
docker mcp gateway run --catalog registry.internal.corp/mcp/team-catalog:latest
```

The `volumes` / `env` / `workingDir` schema at the per-server level varies
across Docker Desktop versions — the [catalog-entry.example.yaml](docker/catalog-entry.example.yaml)
ships with commented hints. Validate against your toolkit's current reference
before rolling out; if in doubt, fall back to the raw `docker run` invocation
above.

### What this does not solve

- **Active-repo discovery.** A container has no view of the user's full
  filesystem. The MCPB path remains the right answer for the everyday
  "I just `cd`'d into a different repo" workflow.
- **Cross-environment paths.** WSL/Windows path translation still applies
  (see the WSL section above); bind mounts in WSL pointing at `/mnt/c/...`
  carry the same performance cost as the non-Docker path.

---

## Testing

The suite is split into four layers, in increasing fidelity:

| Layer | Path | Speed | Runs in CI? |
|---|---|---|---|
| **Unit** | [test/unit/](test/unit/) | <100ms | ✅ |
| **Integration** | [test/integration/](test/integration/) | ~400ms (spawns the compiled bridge per file, drives it via real MCP Client over stdio) | ✅ |
| **Scenarios** | [test/scenarios/](test/scenarios/) | ~300ms (multi-repo journeys: greenfield onboarding, contract drift + recovery, watches filter, resolution precedence) | ✅ |
| **Headless E2E** | [test/e2e-headless/](test/e2e-headless/) | ~10s each (spawns real `claude -p` and asserts the bridge was driven correctly) | ❌ local-only |

```bash
npm test                    # unit + integration + scenarios (everything CI runs)
npm run test:watch          # vitest watch mode
npm run test:coverage       # with v8 coverage report
RUN_E2E_HEADLESS=1 npm run test:e2e   # local-only — see below
```

### Why headless E2E tests don't run in CI

The headless tests spawn `claude -p` and drive the bridge as a real agent would. They need a Claude account (subscription OAuth via `~/.claude/.credentials.json`, or a long-lived token from `claude setup-token` exported as `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`). The default CI workflows in this repo deliberately do **not** wire up any of those — running the suite on every PR would cost real money and the value-vs-cost tradeoff isn't compelling for a small project. Developers should run them locally before tagging releases.

If you want to enable them in CI:
1. `claude setup-token` locally — get a long-lived OAuth token tied to your subscription.
2. Add it as a GitHub Actions secret named `CLAUDE_CODE_OAUTH_TOKEN`.
3. Add a `RUN_E2E_HEADLESS: "1"` env and `CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` to a CI step that runs `npm run test:e2e`.

---

## Dev workflow

```bash
# Fast iteration (no build step)
npm run dev

# Production
npm run build && npm start
```
