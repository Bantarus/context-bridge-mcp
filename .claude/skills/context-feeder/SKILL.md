---
name: context-feeder
description: >
  Feeds and maintains .context/ files so the context bridge MCP stays in sync
  with the actual code. Use this skill whenever Claude Code finishes implementing
  a component, service, screen, schema, event, or any architectural piece that
  other repos might need to know about. Also trigger when starting work in a repo
  that has no .context/ folder yet (initial scaffold), when an existing context
  file is stale or missing, or when the user says things like "update the context",
  "document this", "sync the bridge", "add this to context", or "write back".
  Do NOT skip this step after implementing — context drift is the main failure
  mode of the bridge pattern. Trigger even if the user didn't ask explicitly.
---

# Context feeder

Keeps `.context/` files accurate and current after implementing code changes.
The MCP bridge is only useful if what it reads reflects the real codebase.

---

## When to trigger

Trigger this skill after any of these events:

- Finishing implementation of a new component, screen, service, schema, or event
- Modifying an existing component's public interface or data shape
- Adding or removing an endpoint, RPC, or event
- Starting fresh in a repo with no `.context/` folder
- User asks to "document", "sync", "update context", or "write back"
- Spotting a `.context/` file that contradicts the current code

---

## Core rules

**Rule 1 — Write back immediately after implementing.**
Don't batch context updates. Each implementation session ends with a
`bridge_update` call before closing the task.

**Rule 2 — Only document what this repo owns.**
Each repo documents its own domains and components.
Contracts belong to both sides — update them when the interface changes.

**Rule 3 — Context files describe interface, not implementation.**
Write what other repos (or future Claude sessions) need to know to
*interact with* this component — not how it works internally.
Internal implementation details go in code comments, not in `.context/`.

**Rule 4 — Keep manifest.json current.**
After creating a new domain folder or component file, patch the manifest.
The manifest is what `bridge_manifest()` returns — it's the table of contents.

**Rule 5 — Contracts need explicit versioning.**
Every change to a contract file must include a changelog entry with date.

**Rule 6 — Register the repo in the ecosystem.**
After scaffolding a new repo, call `bridge_register` so other repos can
discover it via `bridge_discover`.

---

## Workflow

### Step 1 — Check if .context/ exists

```
bridge_manifest()
```

If it returns an error or empty, go to **Initial scaffold** below.
If it returns data, go to **Update existing context**.

---

### Initial scaffold (new repo)

When `.context/` doesn't exist yet, create the minimal structure:

**1. Identify the repo's domains**

Look at the codebase and determine the natural groupings:
- What are the top-level feature areas?
- What does this repo expose to the outside?
- Are there shared data models or events?

Common domain patterns (use what fits, invent your own):
```
screens/       UI screens (frontend)
components/    UI components (frontend)
services/      Business logic services (backend)
schemas/       Data models / DB schemas (backend)
events/        Event bus definitions (any)
api/           REST or RPC surface (any)
contracts/     Inter-repo agreements (shared)
```

**2. Create manifest.json**

```typescript
bridge_manifest_update({
  patch: {
    version: "1.0",
    project: "<repo-name>",
    stack: "<tech stack>",
    domains: {
      "<domain>": []  // empty array, will grow as files are added
    }
  }
})
```

**3. Write the first context file**

Start with whatever you just implemented. See file format below.

**4. Register in the ecosystem**

```typescript
bridge_register({
  name: "<repo-name>",
  path: process.cwd(),
  exposes: ["contracts", "<other-public-domains>"],
  stack: "<tech stack>"
})
```

This lets other repos discover this one via `bridge_discover()`.
Include `"contracts"` in `exposes` if this repo has API contracts
that other repos should be able to find automatically.

**5. Install companion skills**

```
bridge_sync_skills()
```

This copies the context-reader, context-feeder, and context-bridge skills
into this repo's `.claude/skills/` so Claude Code knows how to use the bridge.

---

### Update existing context

**For a component you just implemented or modified:**

1. Read the current file if it exists:
   ```
   bridge_get("<domain>", "<component>")
   ```

2. Write the updated version:
   ```
   bridge_update("<domain>", "<component>", <content>)
   ```

3. If it's a new component, add it to the manifest:
   ```
   bridge_manifest_update({
     patch: {
       domains: { "<domain>": [...existing, "<component>"] }
     }
   })
   ```

**For a contract you just changed:**

```
bridge_update_contract("<domain>", <content>)
```

Always add a changelog line with today's date.

**If the repo's exposed domains changed:**

Re-register to update the ecosystem:
```
bridge_register({
  name: "<repo-name>",
  path: process.cwd(),
  exposes: ["contracts", "<updated-domain-list>"],
  stack: "<stack>"
})
```

---

## Context file format

Every `.context/<domain>/<component>.md` file follows this structure.
Only include sections that are relevant — omit empty ones.

```markdown
# <Component name>

## Purpose
One sentence. What this does and why it exists.

## Exposes
What this makes available to callers or other repos.
Use the format that fits: endpoint list, event names, exported types, props.

<for a service/API>
- `<method>(params)` → response shape
- `<method>(params)` → response shape

<for a UI component>
- Props: <list>
- Emits: <event list>

<for a schema/model>
| Field | Type | Notes |
|-------|------|-------|
| id    | uuid | PK    |

## Consumes
What external contracts, events, or services this depends on.
(Omit if purely internal)

## Constraints
Invariants, limits, or rules Claude must know before modifying this.
Examples: rate limits, auth requirements, ordering guarantees.

## Last updated
YYYY-MM-DD
```

---

## Contract file format

Contracts describe the agreement between two repos. They live in
`.context/contracts/<domain>.md`.

```markdown
# Contract: <domain>

## Version
1.x

## Parties
- Repo A exposes: <what it provides>
- Repo B consumes: <what it expects>

## Interface

### <endpoint or event name>
- Direction: A → B | B → A | bidirectional
- Input: <shape>
- Output: <shape>
- Errors: <list>

## Shared types
<list types both sides use, with their shapes>

## Changelog
- YYYY-MM-DD: <what changed>
```

---

## What NOT to put in context files

- Internal implementation details (algorithm choices, private methods)
- Code snippets — describe the shape, not the code
- TODOs or temporary notes — these belong in code comments
- Anything that changes faster than the interface (internal state, cache keys)
- Secrets, tokens, credentials

---

## Checklist before closing a task

Run through this after every implementation session:

- [ ] `bridge_get("<domain>", "<component>")` reflects current code
- [ ] If interface changed: `bridge_update_contract("<domain>")` with changelog
- [ ] If new file created: manifest updated via `bridge_manifest_update`
- [ ] If new repo: registered via `bridge_register`
- [ ] "Last updated" date is today
- [ ] No internal implementation details leaked into context files

---

## Reference: domain naming guide

Read `references/domain-patterns.md` when uncertain how to name or group domains.

---

## Examples

See `references/examples.md` for concrete before/after examples of well-written
vs poorly-written context files.
