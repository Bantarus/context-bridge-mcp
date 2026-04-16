# Context Bridge MCP

A lightweight, project-agnostic MCP server that gives Claude Code agents shared
context across multiple repos on the same machine. Each repo owns its own
`.context/` folder — the server is a stateless I/O tool with zero project knowledge.

---

## Setup

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
  -- node /absolute/path/to/context-bridge-mcp/dist/index.js \
  --env CONTRACTS_ROOT=/absolute/path/to/shared-contracts
```

Or use `claude.json.example` as a template for per-repo configuration.

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

When you start working, Claude Code calls `bridge_manifest()` to see what
domains exist, then fetches only the ones relevant to the task:

```
bridge_manifest()              ← what domains does this repo have?
bridge_discover()              ← what other repos exist in the ecosystem?
bridge_get("routes", "users")  ← fetch the context I need
bridge_get_contract("users")   ← resolved automatically from ecosystem
```

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

The bridge works between repos in the same environment (WSL-to-WSL or
Windows-to-Windows) with no extra setup. Cross-environment usage (WSL repo
talking to a Windows repo or vice versa) requires using cross-filesystem
mount paths when registering.

**If the MCP server runs in WSL**, register Windows projects via `/mnt/c/`:

```
bridge_register({
  name: "my-windows-project",
  path: "/mnt/c/Users/you/projects/my-app",
  exposes: ["contracts", "api"],
  stack: "..."
})
```

**If the MCP server runs on Windows**, register WSL projects via the UNC path:

```
bridge_register({
  name: "my-wsl-project",
  path: "\\\\wsl$\\Ubuntu\\home\\you\\DEV\\my-app",
  exposes: ["contracts"],
  stack: "..."
})
```

**Caveats:**

- `/mnt/c/` access from WSL has a performance overhead (filesystem bridge)
- File watching does not work across the boundary
- Two separate Claude Code instances (one in WSL, one in Windows) need two
  MCP server processes, but can share the same `ecosystem.json` by setting
  `ECOSYSTEM_ROOT` to a path both environments can access

**Recommendation:** keep all repos in the same environment (ideally WSL).
Use cross-mount paths only when you have no choice.

---

## Dev workflow

```bash
# Fast iteration (no build step)
npm run dev

# Production
npm run build && npm start
```
