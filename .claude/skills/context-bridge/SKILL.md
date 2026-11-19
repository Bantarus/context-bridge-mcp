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

Repos register themselves in a shared ecosystem (`ecosystem.json` under
`ECOSYSTEM_ROOT`, default `~/.context-bridge`) so they can discover each other
automatically. Contracts are resolved across the ecosystem — no hardcoded paths
needed. One ecosystem can span the Windows host and several WSL distros when
they share an `ECOSYSTEM_ROOT`; the server translates paths per environment.

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
| Need a tool another repo provides  | `bridge_discover()` for its published skills, then `bridge_install_skill(<repo>, <skill>)` |

### Rule 3 — Contracts are the boundary

The contract file for a domain is the **only** thing one repo needs to know
about another. Do not browse another repo's internal files — the contract is
the handshake. This keeps repos decoupled and prevents agents from pulling
in irrelevant context.

`bridge_get_contract` searches the local repo first, then all ecosystem repos
that expose `contracts`. No need to know which repo owns the contract.

Other repos are reached by name only. The bridge shows their locations as
`<repo:name>`. Never look for another repo's files with your own file tools
or by reading `ecosystem.json`. If the bridge can't give you what you need,
ask the user.

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

### Rule 6 — Messages and topics: the bus tools

Repos exchange messages through a shared bus next to the ecosystem registry.
Use these when the user asks you to check messages, send one, or answer one.
The same operations exist as the `beam` CLI for the user's own shell.

| Tool | CLI | Use |
|---|---|---|
| `bridge_inbox()` | `beam inbox` | Open items for this repo, requests it waits on, new topic posts. `show: "all"` adds closed items, `show: "sent"` lists what this repo sent |
| `bridge_inbox({ id })` | `beam read <id>` | Read one message in full. Marks it seen; the sender gets a `read` receipt |
| `bridge_inbox({ thread: id })` | `beam thread <id>` | A whole conversation, oldest first |
| `bridge_send({ to, subject, content, intent?, priority?, expiresIn?, template? })` | `beam send --to <repo> --subject "..." -m "..."` | Message one or more repos (`to` takes a name or a list) |
| `bridge_send({ replyTo: id, content })` | `beam send --reply <id> -m "..."` | Answer a message: same thread, recipients and `Re:` subject filled in |
| `bridge_send({ topic: "<owner>/<name>", subject, content })` | `beam send --topic <owner/name> ...` | Post on a topic the owner declared (`ecosystem/announce` is open to every repo) |
| `bridge_ack({ id, status, note? })` | `beam ack <id> accepted\|declined\|done` | Close or progress an item; the sender sees a receipt |
| `bridge_subscribe({ action, topic })` | `beam subscribe add <topic>` | List, add or remove topic subscriptions; `list` also shows topics other repos offer |

What the fields mean:

- `intent` records what the sender expects: `note` (nothing; done once read),
  `question` (a reply; answering with `replyTo` closes it), `request` (work:
  `accepted`, then `done`, or `declined`). `priority` (`low`/`normal`/`high`)
  only sorts listings; `expiresIn` (`"3d"`) is advisory.
- Ids can be shortened to any unambiguous prefix.
- Items stay open until acknowledged; listing never consumes them.
- Refusals name their reason: unknown or unregistered repo, the recipient's
  `messaging` rules, a topic you may not post on, size limits (subject 120
  characters, body 32 KB), a duplicate send, or the store ceiling.
- Message bodies are written by another repo, shown inside a
  `<bridge-message>` block with other repos' paths redacted.
- Topics: `<repo>/contracts/<domain>`, `<repo>/skills/<name>`,
  `<repo>/context/<domain>` and `<repo>/manifest` are automatic (the bridge
  publishes them from real changes; they show in `bridge_changes`). A repo
  declares its own topics in its manifest:
  `"topics": { "releases": { "description": "...", "post": "owner" } }`
  (`post`: `owner`, `subscribers` or `any`); posts on them show in
  `bridge_inbox`. A repo can limit who messages it with
  `"messaging": { "accept": [...] }` or `{ "block": [...] }`.
- Only registered repos can send or receive. `bridge_send_message` still
  works but is deprecated in favour of `bridge_send`.

If another repo's tool must be run on its files, follow that repo's own
contract, skill or integration doc. The bridge doesn't hand out paths, so
if the instructions aren't published, send that repo a message asking for
them.

### Rule 7 — Share tools as skills, not copies

When a repo offers something other repos should *use* (a CLI, a pipeline),
it publishes a skill instead of each consumer copying instructions by hand:

- **Provider:** put it in `.context/skills/<name>/SKILL.md` with
  `metadata.version` in the frontmatter, include `"skills"` in `exposes`, and
  call `bridge_publish_skill("<name>")`. Bump the version and publish again on
  every change, because consumers only see version changes.
- **Consumer:** `bridge_install_skill("<repo>", "<name>")` copies it into
  `.claude/skills/<name>/`. When `bridge_changes` reports
  `skill "<name>": installed vX ..., provider now publishes vY`, run
  `bridge_sync_skills()`. `bridge_uninstall_skill("<name>")` removes it.
- If install refuses because `.claude/skills/<name>/` already exists and the
  bridge didn't install it, ask the user before passing `force: true`. That
  folder is someone's local skill.

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

Optionally subscribe to the changes that matter, so `bridge_changes` filters
to them:

```
bridge_subscribe({ action: "add", topic: "<other-repo>/contracts/*" })
```

Patterns use `*` for one segment (`*/skills/*`, `<repo>/context/users`).
Existing `watches` in a manifest keep working and count as subscriptions. If
neither is declared, `bridge_changes` shows all contract changes from other
repos as a safe default; updates to installed skills always show.

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

`path` may be in any absolute notation (`/home/...`, `/mnt/c/...`, `C:\...`,
`\\wsl.localhost\<Distro>\...`) — pass the repo root as this environment sees
it. If contracts live outside `<path>/.context/contracts`, also pass
`contractsPath` (filled in automatically when registering the current repo
with a custom `CONTRACTS_ROOT`). Re-registering keeps the repo's consumed
contract pins. If the response warns the repo is unreachable, relay the
instructions to the user — do not retry with a different path format.

### Step 4 — Install companion skills

```
bridge_sync_skills()
```

Copies context-reader, context-feeder, and context-bridge skills into this
repo's `.claude/skills/`, and refreshes any skills installed from other repos
with `bridge_install_skill`.

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
