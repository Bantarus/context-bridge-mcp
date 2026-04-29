---
name: context-bridge
description: >
  Coordinate cross-repo features using the Context Bridge MCP. Use this skill
  whenever a task spans multiple repos or architecture layers (frontend ↔ backend,
  mobile ↔ API, service ↔ service, worker ↔ gateway, or any combination
  registered in the ecosystem). Also use it when the user mentions
  "bridge", "contract", "cross-layer", "cross-repo", shared API surfaces,
  or when you detect that a feature touches endpoints, events, or shared
  types consumed by another repo. Even if the user doesn't mention the
  bridge explicitly, activate this skill when the work clearly crosses a
  repo boundary.
---

# Context Bridge — Cross-Repo Feature Coordination

The Context Bridge MCP is a stateless tool that reads and writes `.context/`
folders in each repo. It acts as the shared context layer for how repos
communicate. Each repo owns its own `.context/` — the server has zero
project-specific knowledge.

Repos register themselves in a shared ecosystem (`~/.context-bridge/ecosystem.json`)
so they can discover each other automatically. Contracts are resolved across the
ecosystem — no hardcoded paths needed.

---

## Rules

### Rule 1 — Orient first

Always call `bridge_manifest`, `bridge_discover`, and `bridge_changes` at the
start of a session. Never assume what domains or repos exist. The manifest tells
you what this repo owns. The ecosystem tells you what other repos exist and what
they expose. Changes tells you what other repos modified since your last session.

### Rule 2 — Fetch with precision

Fetch only what you need for the current task:

| Situation                          | What to fetch                                                            |
|------------------------------------|--------------------------------------------------------------------------|
| Working on a known component       | `bridge_get(<domain>, <component>)` + its contract if cross-repo         |
| Need cross-repo API details        | `bridge_get_contract(<domain>)` — auto-resolves from ecosystem           |
| Cross-repo data mismatch           | Contract + context files from both sides via `bridge_get_from`           |
| Don't know what exists             | `bridge_list()` or `bridge_list(<domain>)`                               |
| Don't know which repo owns something | `bridge_discover()` — lists all repos and exposed domains              |

### Rule 3 — Contracts are the boundary

The contract file for a domain is the **only** thing one repo needs to know
about another. Do not browse another repo's internal files — the contract is
the handshake. This keeps repos decoupled and prevents agents from pulling
in irrelevant context.

`bridge_get_contract` searches the local repo first, then all ecosystem repos
that expose `contracts`. No need to know which repo owns the contract.

Every call to `bridge_get_contract` automatically pins the consumed version.
When `bridge_changes` runs, it compares pinned versions against current versions
and reports drift. This is why contracts **must** have a `## Version` section.

### Rule 4 — Write back after implementing

Whenever you change something that affects the cross-repo surface (a new
endpoint, event, state shape, or shared type), update the bridge immediately:

```
bridge_update(<domain>, <component>, <updated markdown>)
bridge_update_contract(<domain>, <updated content>)   # if API surface changed
```

### Rule 5 — Register new domains and repos

After creating a new context file or contract, patch the manifest so other
agents can discover it:

```
bridge_manifest_update({ patch: { ... } })
```

For new repos, register in the ecosystem:

```
bridge_register({
  name: "<repo-name>",
  path: process.cwd(),
  exposes: ["contracts", "<domains>"],
  stack: "<tech stack>"
})
```

---

## Context file template

```markdown
# <Component / Service name>

## Purpose
One-sentence description.

## Exposes
What this makes available to callers or other repos.

## Consumes
What contracts, events, or services this depends on.

## Constraints
Invariants, limits, or rules to know before modifying.

## Last updated
YYYY-MM-DD
```

## Contract file template

```markdown
# Contract: <domain>

## Version
<semver>

## Parties
- Repo A exposes: <component or service>
- Repo B consumes: <component or service>

## Endpoints / RPCs

### <endpoint name>
- Direction: A → B | B → A | bidirectional
- Request: <field list or JSON shape>
- Response: <field list or JSON shape>
- Errors: <list>

## Events

### <event name>
- Emitter: <repo>
- Payload: <field list>

## Shared types used
- <TypeName> (see .context/schemas/<type>.md)

## Changelog
- YYYY-MM-DD: <what changed>
```

The `## Version` section is required — the bridge extracts it to track which
version each repo consumed. When a contract is updated, `bridge_changes`
compares the pinned version against the current version and warns about drift.
Always bump the version when changing a contract.

---

## Examples

**Example 1 — Adding a feature that crosses two repos**

Input: "Add a ready-up button that notifies the server when a player is ready"

```
1. bridge_manifest()
   → understand this repo's domains

2. bridge_discover()
   → see what other repos exist (e.g. game-backend)

3. bridge_changes()
   → see if the other repo changed anything since last session

4. bridge_get("<domain>", "<component>")
   → current state, events, API calls for your side

5. bridge_get_contract("<domain>")
   → auto-resolved — the agreed API surface

6. < implement the feature >

7. bridge_update("<domain>", "<component>", <updated content>)
   → bridge reflects the new state

8. bridge_update_contract("<domain>", <add new endpoint>)
   → the other repo's agent sees the change via bridge_changes()
```

Output: Contract updated with the new endpoint. Your repo's context file
reflects the new state. The other repo's developer or agent can now pick up
the contract change without browsing your code.

**Example 2 — Fixing a cross-repo type mismatch**

Input: "Repo A sends `rank` as a string but repo B expects an int"

```
1. bridge_manifest()
2. bridge_discover()
3. bridge_get("schemas", "<model>")        → this repo's type definition
4. bridge_get_contract("<domain>")          → what shape the API declares
5. bridge_get_from("<other-repo>", "schemas", "<model>")  → check the other side (uses ecosystem name)
6. < fix the type in whichever repo is wrong >
7. bridge_update("schemas", "<model>", <corrected definition>)
8. bridge_update_contract("<domain>", <corrected shape if needed>)
```

**Example 3 — Adding a brand new cross-repo domain**

Input: "Add a real-time notifications system"

```
1. bridge_manifest()
2. bridge_discover()
3. bridge_update_contract("notifications", <new contract>)
4. bridge_update("<domain>", "notifications", <context>)
5. bridge_manifest_update({ patch: {
     domains: { ..., notifications: [...] }
   }})
6. bridge_register({
     name: "<this-repo>",
     path: process.cwd(),
     exposes: [...existing, "contracts"],
     stack: "<stack>"
   })
```

Output: New domain registered. Contract defines the boundary. Any agent in
any repo can discover and consume it via `bridge_get_contract("notifications")`.

---

## Onboarding a new repo into the ecosystem

### Step 1 — Choose domain names

Domain names are folder names under `.context/`. They should be:
- **Plural nouns** — `screens/`, `services/`, `events/`
- **Stable** — don't rename often, other repos reference them
- **Meaningful to outsiders** — readable from another repo

### Step 2 — Create manifest and context files

```
bridge_manifest_update({
  patch: {
    version: "1.0",
    project: "<repo-name>",
    stack: "<tech stack>",
    domains: {
      "<domain>": ["<component>"]
    }
  }
})
```

Write context files for each component. At minimum, fill in Purpose and Exposes.

Optionally declare `watches` so `bridge_changes` filters to relevant updates:

```
bridge_manifest_update({
  patch: {
    watches: {
      "<other-repo>": ["contracts", "schemas"]
    }
  }
})
```

If no `watches` are declared, `bridge_changes` shows all contract changes from
other repos as a safe default.

### Step 3 — Register in the ecosystem

```
bridge_register({
  name: "<repo-name>",
  path: process.cwd(),
  exposes: ["contracts", "<other-public-domains>"],
  stack: "<tech stack>"
})
```

Include `"contracts"` in `exposes` so `bridge_get_contract` can auto-resolve
contracts from this repo.

### Step 4 — Install companion skills

```
bridge_sync_skills()
```

Copies context-reader, context-feeder, and context-bridge skills into this
repo's `.claude/skills/`.

### Step 5 — Verify discoverability

From another repo, run:
```
bridge_discover()
```

The new repo should appear with its exposed domains. Then test:
```
bridge_get_contract("<domain>")
```

It should resolve the contract from the ecosystem without a hardcoded path.

---

## When NOT to use

- **Single-repo work** — Refactoring internals, fixing a bug that doesn't
  change the API surface, UI-only styling, internal logic changes. If no
  other repo is affected, skip the bridge.

- **Reading your own source code** — The bridge stores architecture context
  as markdown, not source code. Use normal file reads for implementation
  details within your repo.

- **CI/CD, tooling, infra** — Build pipelines, deploy configs, and dev
  tooling don't cross repo boundaries in a way the bridge tracks.

- **Early prototyping** — If you're spiking inside one repo and haven't
  defined a cross-repo API surface yet, wait until the contract is ready.

- **Bridge MCP not connected** — If `bridge_manifest` fails or returns an
  error, the MCP server isn't configured. Fall back to reading docs or
  asking the user for cross-repo context.
