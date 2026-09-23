---
name: context-reader
description: >
  Orients Claude Code at the start of a work session by loading only the
  relevant context from .context/ via the bridge MCP — no more, no less.
  Use this skill at the very beginning of any session in a repo that has a
  .context/ folder, before writing any code or making any plan. Also trigger
  when the user says things like "let's work on X", "I need to implement Y",
  "continue on Z", "what do we have for this feature", "what's the current
  state of", or any task description that implies touching a specific domain,
  screen, service, or cross-repo interface. Trigger before asking clarifying
  questions — orient first, then ask. Do NOT load everything: fetch only what
  the current task actually requires.
---

# Context reader

Loads exactly the right context from `.context/` before starting work.
The goal is a sharp, targeted context window — not a full dump.

---

## Core principle

**Load the minimum that answers: "what do I need to know to do this task?"**

Too little context → wrong assumptions, drift from existing architecture.
Too much context → wasted tokens, diluted focus, slow sessions.

The manifest is always the first call. Everything else is selective.

---

## Step 1 — Always: orient with manifest, ecosystem, and changes

```
bridge_manifest()
bridge_discover()
bridge_changes()
```

From the manifest, extract:
- What domains exist in this repo
- What the project is and its stack

From the ecosystem, extract:
- What other repos exist on this machine
- What domains each repo exposes publicly

From changes, extract:
- What context or contracts changed in other repos since last session
- Whether any of those changes affect what you're about to work on

Do not proceed until you've read all three.

---

## Step 2 — Identify task scope

From the user's request, determine:

| Task type | What you need |
|-----------|--------------|
| Work on one component | That component's file + its contract if cross-repo |
| Add a new component to an existing domain | 1-2 sibling files for reference + contract |
| Change a cross-repo interface | Both sides' files + the contract |
| Debug a mismatch between repos | Contract + both sides' relevant files via `bridge_get_from` |
| Implement a feature that spans multiple domains | One file per domain touched, contracts for each |
| Start fresh with no clear scope | Ask the user to narrow down before fetching |

---

## Step 3 — Fetch selectively

### Working within this repo

```
bridge_get("<domain>", "<component>")
```

Fetch **one file at a time**. Only fetch the next file if the current one
references something you need to understand. Stop when you have enough to act.

### Reading a contract

```
bridge_get_contract("<domain>")
```

Always fetch the contract when the task touches a cross-repo interface,
even if you think you know its shape. Contracts may have changed.

`bridge_get_contract` is ecosystem-aware: it searches the current repo first,
then all registered repos that expose `contracts`. No need to know which
repo owns the contract.

### Reading from another repo

```
bridge_get_from("<repo-name>", "<domain>", "<component>")
```

Pass the ecosystem repo name (from `bridge_discover`). The server resolves
the path internally — you never need to know where the repo lives on disk.

Use only when debugging a cross-repo mismatch or implementing something
that requires understanding the other side's internals.
Prefer `bridge_get_contract` for normal cross-repo work.

### Discovering what exists

```
bridge_list()                    // all files in this repo's .context/
bridge_list("<domain>")          // files in one domain
bridge_discover()                // all repos in the ecosystem
bridge_discover("<repo-name>")   // details + manifest of a specific repo
```

Use when the manifest doesn't list components explicitly, or when you need
to find a file whose name you don't know.

Repos may live in another environment (Windows host, another WSL distro).
`bridge_discover` marks repos that are unreachable from here, and
`bridge_get_from` / `bridge_get_contract` / `bridge_changes` explain why
(e.g. a missing `/mnt/wsl/<Distro>` bind mount). Tell the user how to fix
it rather than assuming the file doesn't exist.

---

## Fetch decision tree

```
User describes a task
        │
        ▼
bridge_manifest()  ← always
bridge_discover()  ← always
bridge_changes()   ← always (shows what changed since last session)
        │
        ▼
Does the task touch a specific component?
    │                       │
   YES                      NO
    │                       │
    ▼                       ▼
bridge_get(domain,    bridge_list() to discover
component)            then ask user to narrow scope
    │
    ▼
Does it cross a repo boundary?
    │                       │
   YES                      NO
    │                       │
    ▼                       ▼
bridge_get_contract()  Ready to act
(auto-resolves from
ecosystem)
    │
    ▼
Need to understand the other side?
    │                       │
   YES                      NO
    │                       │
    ▼                       ▼
bridge_get_from("<repo>",
"<domain>", "<comp>")  Ready to act
```

---

## Step 4 — Summarise before acting

After fetching, state explicitly what you loaded and what you understood.
One short paragraph. This confirms the context is correct before any code
is written and gives the user a chance to correct misunderstandings early.

Example:
> "I've loaded the matchmaking service context and the lobby contract.
> The service exposes `findMatch`, `cancel`, and `status`. The contract
> shows the client expects a `MATCH_FOUND` event with `{ matchId, players, startsInMs }`.
> The ecosystem shows game-client is registered.
> I'll now implement the timeout handling on the backend side."

Do not skip this step. It is the cheapest bug fix in the workflow.

---

## What NOT to load

- The full `.context/` dump — never call `bridge_list()` and then fetch everything
- Sibling components that the task doesn't touch
- The other repo's internals when a contract exists and is sufficient
- Manifests from repos unrelated to the current task
- Context files for future tasks — load them when you get there

---

## Cross-repo session pattern

When a feature spans two repos, follow this sequence:

```
1. bridge_manifest()
   → understand this repo's domains

2. bridge_discover()
   → see what other repos exist and what they expose

3. bridge_get("<domain>", "<component>")
   → load what this repo owns for this feature

4. bridge_get_contract("<domain>")
   → auto-resolved from local or ecosystem repos

5. bridge_get_from("<other-repo>", "<domain>", "<component>")
   → only if contract is insufficient (uses ecosystem repo name)
```

Do NOT load the other repo's internal service or screen files unless the
contract is insufficient to understand what you need to implement.

---

## Checklist before writing any code

- [ ] `bridge_manifest()` called and read
- [ ] `bridge_discover()` called — aware of ecosystem repos
- [ ] `bridge_changes()` called — aware of recent changes from other repos
- [ ] Only task-relevant files fetched
- [ ] Contract loaded if task crosses a repo boundary
- [ ] Loaded context summarised to user
- [ ] No unrelated domains fetched

---

## After the session

Hand off to the context-feeder skill:
once implementation is done, the feeder updates `.context/` to reflect
what was just built. The reader and feeder are two halves of the same loop.
