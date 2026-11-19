# Context Bridge: communication layer design

Status: design, revision 3 (decisions recorded, MVP in progress). Date: 2026-11-19.

Goal, in the user's words: make the context bridge evolve into a communication bridge so coding agents can talk to each other across projects, subscribe to topics from other projects, and check whether they have notifications or messages. End goal: a local, decentralized network for coding agents.

Revision 2 applies the user's correction: the layer is used under supervision, on demand ("you should check your notifications", "you should send a message"), through tools and a CLI. It is not the layer's job to decide how a dev and their agents use it.

## 0. Summary of the recommendation

Add a **bus** next to `ecosystem.json`: one append-only log per author repo, immutable message bodies, and one state file per repo that holds its cursors and its open inbox. Everything the bridge already logs (contract, skill, context and manifest changes) becomes an event on an automatic topic, so `watches` turns into "subscriptions" without anyone editing a manifest.

- **Mechanism, not policy.** The layer stores, routes and shows messages. It does not push, wake, remind, or tell agents how to behave.
- **Two front ends over one core.** MCP tools for agents and a CLI for the human (or an agent in a shell), with the same operations generated from one table.
- **Pull only.** Mail is seen when someone asks: `bridge_inbox` or `context-bridge-mcp inbox`.
- **Mailbox = repo.** Sessions are ephemeral senders, not addresses.
- **Messages stay open until acknowledged.** Today a message is shown once and then gone.
- **Bodies live on the bus**, not in the sender's `.context/requests/`, so a recipient in another WSL distro can always read them.
- **Four new tools:** `bridge_inbox`, `bridge_send`, `bridge_ack`, `bridge_subscribe`. `bridge_send_message` stays as an alias.
- **Per-author logs are the decentralization bet.** Each repo only ever appends to its own files, so phase 3 can replicate them between machines with plain folder sync and no conflicts.

How the claims below were checked:

| Label | Meaning |
|---|---|
| **[code]** | Read in this repo at the cited `file:line`. |
| **[sdk]** | Read in `node_modules/@modelcontextprotocol/sdk` (version 1.27.1). |
| **[data]** | Read from the real ecosystem folder (read-only). |
| **[inferred]** | My reasoning; needs a test before relying on it. |

## 1. What exists today, and what it tells us

### 1.1 Real traffic [data]

- 24 registered repos, living in three places: Windows drives, WSL `Ubuntu`, WSL `Ubuntu-24.04`.
- `changelog.jsonl`: 295 entries in 8 weeks (2026-09-23 to 2026-11-19), 50 KB. One of them is a message (vessel to voicy, today).
- 13 of 24 repos have a `changelogCursor`; the other 11 have never called `bridge_changes`.
- 6 repos expose `requests`.
- Sender names in the changelog do not all match registered names: `storytelling-IP` and `storytelling-ip`, `25D-animate` and `25d-animate`, `flutter_xros_client`, `unity-ithappy`, `rive-docs`.

Volume is tiny. Not losing a message and knowing who sent it matter far more than throughput.

### 1.2 Gaps in the current messaging [code]

| # | Gap | Where |
|---|---|---|
| G1 | A message is shown once. `bridge_changes` advances the cursor as soon as it has printed the message, whether or not anyone acted on it. The test asserts this. | `src/index.ts:2074-2077`, `2173-2180`; `test/integration/feedback_2026_11.test.ts:177-178` |
| G2 | No threads. `inReplyTo` is only written into the markdown header, not into the changelog entry. | `src/index.ts:2414`, `2439-2447` |
| G3 | The recipient reads the body from the sender's repo with `bridge_get_from`. If the sender's repo is not reachable from the recipient's environment, the message is unreadable. | `src/index.ts:2379-2462`, tool description at `1516-1521` |
| G4 | Sending a message adds `requests` to the sender's `exposes` without asking anyone. | `src/index.ts:2431-2437` |
| G5 | Identity is self-asserted: the manifest's `project`, else the working directory name. Nothing ties it to the registered entry, hence the mismatched names in 1.1. | `src/index.ts:1083-1090` |
| G6 | The manifest is read, modified and written back without a lock when sending. Two sessions in the same repo can lose each other's update. | `src/index.ts:2419-2428` |
| G7 | There is no way to look at messages except through an agent, and no dedicated "check my messages" operation: messages are a section of `bridge_changes`. | `src/index.ts:2048` |
| G8 | Every check reads and parses the whole changelog. | `src/index.ts:1137-1158` |
| G9 | Stale-lock takeover is racy: two waiters can both see a stale lock, and the second `rm` can delete the first one's fresh lock. | `src/index.ts:132-139` |

### 1.3 What is good and stays

- Atomic writes with rename retry for drvfs: `writeFileAtomic`, `src/index.ts:209-237`.
- The `O_EXCL` lock that works across Windows and WSL: `withEcosystemLock`, `src/index.ts:123-159`, and the rule "re-read under the lock, never write back a snapshot", `165-173`.
- Position cursors instead of timestamps, with partial trailing lines ignored: `src/index.ts:1130-1158`, `2062-2071`.
- Path translation (`toCanonicalPath` at `373`, `toLocalPath` at `416`) and the redactor (`buildPathRedactor` at `973`, applied to every non-verbatim block and every error at `1573-1602`).
- Refusing to send from an unregistered repo: `src/index.ts:2383-2395`.

## 2. Concepts

### 2.1 Identities

| Identity | Example | Lifetime | Used for |
|---|---|---|---|
| **Repo** | `voicy` | Durable. Created by `bridge_register`, which the human approves. | The address. Owns a mailbox, topics, subscriptions and (phase 2) a signing key. |
| **Session** | `voicy#k3f9` | One bridge process or one CLI invocation. Random suffix. | Sender metadata, and recording who accepted a request. Not an address. |
| **Via** | `tool`, `cli`, `bridge` | Per envelope. | Records how the envelope was produced: through an MCP tool, through the CLI, or generated by bridge code from a real file change. The layer cannot know whether a human or an agent typed a CLI command, so it does not claim to. |
| **Node** (phase 3) | `desktop-win` | Per machine or environment. | Distinguishes clones of one repo on two machines: `voicy@desktop-win`. |

Decisions:

- **The mailbox is the repo.** A session is gone when the terminal closes, and the next session in that repo is the one that picks the work up.
- **Repo identity comes from the registered path, not the manifest.** The bridge finds the ecosystem entry whose path is the current repo (the lookup `registrationNotice()` already does at `src/index.ts:918-921`) and uses that entry's name. This fixes G5.
- **Unregistered repos cannot send, receive or subscribe.** `registrationNotice()` already tells the agent to ask the user.

### 2.2 Envelope

One JSON line per message, event or receipt:

```json
{
  "v": 1,
  "id": "m-01JD3K9Q7RZ8-4f2a9c",
  "kind": "message",
  "from": { "repo": "vessel", "session": "vessel#k3f9", "via": "tool" },
  "to": ["voicy"],
  "topic": null,
  "thread": "m-01JD3K7A2B1C-99e0aa",
  "replyTo": "m-01JD3K7A2B1C-99e0aa",
  "subject": "Re: reading the llm-lite shard",
  "intent": "reply",
  "priority": "normal",
  "expiresAt": null,
  "lc": 412,
  "ts": "2026-11-19T13:31:22.029Z",
  "body": { "bytes": 1840, "sha256": "9b2f..." },
  "sig": null
}
```

| Field | Notes |
|---|---|
| `id` | Globally unique: a time prefix for readability plus 6 random hex. Uniqueness is the only property relied on. |
| `kind` | `message`, `event` (the bridge generated it), `receipt` (state change of another envelope). |
| `to` / `topic` | Exactly one is set. `to` is a list of repo names. |
| `thread`, `replyTo` | `thread` is the id of the root message. Replies inherit it. Fixes G2. |
| `intent` | `note`, `question`, `request`, `reply`. See 2.5. |
| `lc` | Lamport counter: one more than the highest `lc` this repo has seen or sent. Orders envelopes across authors without clocks. |
| `ts` | Sender's wall clock. Display only. Never used for ordering or cursors. |
| `body` | Size and hash of the body file. Events have a `summary` string instead and no body. |
| `sig` | Reserved. `null` until phase 2. |

### 2.3 Direct messages, mailboxes, threads

- A direct message names one or more repos in `to`.
- Each recipient's **inbox** is the set of envelopes addressed to it that it has not marked `done`. It lives in that repo's state file (3.3).
- A thread is every envelope sharing a `thread` id. Order inside a thread follows `replyTo` links first, then `lc`.
- `to: ["consumers:<contract>"]` (phase 1b) expands at send time to the repos whose `consumedVersions` pin that contract from the sender. This is the "contract changed, please adapt" case, addressed to exactly the repos that depend on it.

### 2.4 Topics and subscriptions

A topic is a named stream owned by a repo: `<owner>/<name>`.

**Automatic topics** are produced by the bridge from the mutations it already logs:

| Topic | Emitted when | Today's equivalent |
|---|---|---|
| `<repo>/contracts/<domain>` | A contract is updated or published | `type: "contract"` |
| `<repo>/skills/<name>` | A skill version is published | `type: "skill"` |
| `<repo>/context/<domain>` | A context file is updated | `type: "context"` |
| `<repo>/manifest` | The manifest is patched | `type: "manifest"` |

**Declared topics** are listed by the owner in its manifest, which the human reviews in git:

```json
"topics": {
  "releases": { "description": "Voicy release notes", "post": "owner" },
  "help":     { "description": "Ask voicy maintainers", "post": "any" }
}
```

`post` is `owner` (default), `subscribers` or `any`.

One shared topic exists without an owner: `ecosystem/announce`, open to every registered repo.

**Subscriptions** are stored in the subscriber's manifest so the human can see and edit them:

```json
"subscriptions": ["voicy/releases", "voicy/contracts/*", "*/skills/*"]
```

`*` matches one path segment. `watches` keeps working and is read as subscriptions:

| `watches` entry | Equivalent subscription |
|---|---|
| `"voicy": ["contracts"]` | `voicy/contracts/*` |
| `"voicy": ["users"]` | `voicy/contracts/users`, `voicy/context/users` |
| `"voicy": ["skills"]` | `voicy/skills/*` |
| `"voicy": ["messages"]` | Dropped. Seeing other repos' direct messages is not a feature worth keeping. |
| No `watches`, no `subscriptions` | `*/contracts/*` (today's default, `src/index.ts:2094-2096`) plus skills installed here |

Topic items land in the subscriber's **feed**, not its inbox. A feed item is informational: it is shown once and dropped, exactly as changelog entries are today.

### 2.5 Requests with expectations

`intent` is data: it records what the sender expects and which state transitions make sense. What a recipient does about it is up to the dev and their agent.

| Intent | Sender expects | Recipient's available outcomes |
|---|---|---|
| `note` | Nothing | `done` (implicit when read) |
| `question` | A reply | A `reply`, or `declined` |
| `request` | Work, then confirmation | `accepted` then `done`, or `declined`. Each with an optional note. |
| `reply` | Nothing by default | `done` (implicit when read) |

Request lifecycle, visible to both sides through receipts:

```
sent ──> read ──> accepted ──> done
                └─> declined
```

A `template` label lets senders phrase common requests consistently: `review`, `adapt-to-contract`, `question-about-context`, `bug-report`. It is a label only.

### 2.6 Acks, read state, receipts

Each inbox item has a state held by the recipient: `new`, `seen`, `accepted`, `done` or `declined`.

- `new` to `seen` happens when the body is fetched, not when a listing shows the item. Fixes G1.
- A `request` or `question` stays open until it is acked or replied to.
- Each transition appends a small `receipt` envelope to the recipient's own log, addressed to the sender. Receipts never appear as inbox items; they update the status the sender sees under "Waiting on others".
- Two sessions in one repo share the inbox. `accepted` records the accepting session, so the other one sees the item as taken.

### 2.7 Notifications

A notification is not a stored object and nothing is pushed. "You have notifications" means: the inbox has items in state `new`, or the feed has unseen items. It is computed when someone asks, through `bridge_inbox` or `context-bridge-mcp inbox`.

### 2.8 Presence

Not in the MVP, and no longer needed by anything in it. Under on-demand use, "is a session open over there" does not change what the layer does with a message.

It remains a small optional addition (phase 1b), purely informational: each bridge process writes `presence/<repo>/<session>.json` at boot, rewrites it every 60 seconds and removes it on exit. `bridge_discover` would then show "1 session open". Liveness would compare file mtimes, which all come from the one filesystem server, the same assumption the lock code makes at `src/index.ts:113-115` **[inferred]**. CLI invocations do not create presence.

### 2.9 Priority and expiry

- `priority`: `low`, `normal`, `high`. It is a sender-supplied label used only to sort and mark listings. The layer attaches no behaviour to it.
- `expiresAt` is advisory and coarse (minimum one hour). An expired item is listed as expired. Nothing is deleted because of it, since it is the sender's clock.

## 3. Phase-1 storage and transport

### 3.1 Layout

```
<ECOSYSTEM_ROOT>/
  ecosystem.json            unchanged
  ecosystem.lock            unchanged
  changelog.jsonl           unchanged; becomes a read-only legacy source (section 4)
  bus/
    meta.json               { "format": 1 }
    policy.json             optional, human-edited store limits (7.5)
    log/
      <author>/             one directory per author repo (lower-cased name)
        000001.jsonl        append-only envelopes, written only by that repo's sessions
        000002.jsonl
        body/<id>.md        immutable message bodies
        .lock
    state/
      <repo>.json           that repo's cursors, inbox, feed
      <repo>.lock
```

### 3.2 Why one log per author

The alternative is one shared log with a global lock, which is what `changelog.jsonl` is today (without the lock). I recommend per-author logs:

- **No cross-environment write contention.** Only sessions of one repo, all in one environment, append to a given file. Windows and WSL processes never append to the same file.
- **A late writer cannot slip behind a reader's cursor.** Cursors are per file, and each file only grows at its end.
- **Phase 3 becomes file replication.** A file with a single writer never conflicts under folder sync.
- **Signing fits.** Each log is one author's chain.

Cost: a reader's cursor is a map of author to position rather than one number, and cross-author order comes from `lc` rather than file position. Readers only care about order inside a thread, which `replyTo` gives exactly.

### 3.3 State file

`state/<repo>.json`, written atomically under `state/<repo>.lock`:

```json
{
  "cursors": { "vessel": { "seg": 1, "off": 18234 }, "_legacy": { "off": 50125 } },
  "lc": 412,
  "inbox": { "m-01JD...": { "state": "new", "from": "vessel", "intent": "request", "priority": "high", "subject": "...", "thread": "...", "lc": 409, "by": null } },
  "feed": [ { "id": "e-...", "topic": "voicy/contracts/users", "summary": "1.9 -> 1.10: ..." } ],
  "sent": { "m-01JD...": { "to": ["voicy"], "intent": "request", "status": "accepted" } },
  "recentSends": [ { "hash": "...", "at": "..." } ]
}
```

Only the owning repo's bridge processes and CLI invocations write this file. `changelogCursor` and `lastCheckedAt` in `ecosystem.json` stop being written by new bridges, which removes a global-lock write from every check (`src/index.ts:2173-2180`).

### 3.4 Operations

**Send**

1. Validate addressing, access rules and store limits (section 7).
2. Write the body to `log/<me>/body/<id>.md` with exclusive create (`wx`). Never renamed, never modified, so no drvfs rename errors.
3. Take `log/<me>/.lock`. Append the envelope line to the head segment with one `appendFile`. Release.

The append in step 3 is the commit point. A crash after step 2 leaves an orphan body that compaction removes.

**Scan** (runs at the start of every inbox, read, ack or changes operation)

1. Read the state file. List `log/`; for each author whose head segment is larger than the stored offset, read from that offset to the last complete newline. A trailing partial line is left for next time, as `readChangelog` does today (`src/index.ts:1148`). Fixes G8.
2. Route each envelope: addressed to me, into `inbox`; matching a subscription, into `feed`; a receipt for something I sent, update `sent`. Drop what the access rules reject (7.4). Deduplicate by `id`.
3. Under the state lock, re-read the state, merge, and write it back atomically.

A scan with nothing new costs one directory listing and one `stat` per author. It only runs when someone asks, so there is no hot path to optimise.

### 3.5 Locking

- Generalise `withEcosystemLock` into `withLock(path, fn)`. The bus uses per-author and per-repo locks; `ecosystem.lock` keeps its current job.
- Never hold two locks at once.
- Fix G9 while generalising: write a random token into the lock, and when taking over a stale lock, rename it to a unique name first and delete that. Only one waiter's rename succeeds.

### 3.6 Ordering without trusted clocks

| Need | Mechanism |
|---|---|
| Order within one author | Position in that author's log |
| Order within a thread | `replyTo` links, then `lc`, then author name |
| Order across authors in a listing | `lc`, then author name |
| "What have I already seen?" | Per-author byte offsets |
| Lock staleness, segment age | File mtimes, all stamped by the one filesystem server |
| Display dates | `ts`, labelled as the sender's clock |

### 3.7 Rotation, compaction, retention

- **Rotation**: a new segment starts at 1 MB or 5,000 lines, under the author lock.
- **Retention**: off in the MVP. At the measured rate (295 entries in 8 weeks) the bus reaches 1 MB in years.
- **Compaction, phase 1b**: a CLI command the human runs (`context-bridge-mcp compact`). An author's segment may be deleted when it is older than 90 days by mtime and every registered repo's cursor is past it. For repos whose cursor is behind (11 of 24 have never checked), the compactor first re-appends still-open direct messages addressed to them into the author's head segment with `"carried": true`. Bodies whose envelopes are gone are deleted with the segment.
- Feed items that a dormant repo never read are lost at compaction. The repo's next inbox listing says so ("events before <date> were dropped") and drift detection still catches the contract and skill changes that matter, because it compares current files rather than history (`src/index.ts:2112-2170`).

### 3.8 Cross-environment checks

- All bus paths are derived from `ECOSYSTEM_ROOT`, never from another repo's path, so `toLocalPath` is not involved in reading a message. Fixes G3.
- Author directory names are the lower-cased repo name, validated against the existing name pattern (`SKILL_NAME_RE`, `src/index.ts:538`) and `assertSafePath`. Lower-casing avoids `storytelling-IP` and `storytelling-ip` colliding on NTFS.
- No file is ever renamed over another one that readers hold open, except the state file, which already has the retrying `writeFileAtomic`.
- No inotify and no polling. Nothing watches the folder.

## 4. Migration

### 4.1 Keep, reshape, deprecate

| Existing piece | Decision |
|---|---|
| `changelog.jsonl` | **Keep, frozen format.** New bridges read it as a legacy source with its own cursor (`_legacy`), and never rewrite or truncate it. |
| Mutation logging (`appendChangelog`, `src/index.ts:1092`) | **Reshape.** Writes an `event` envelope to the bus on the matching automatic topic. During the transition it also writes the old changelog line, tagged `"bus": "<id>"`. |
| `watches` | **Keep, read as subscriptions** (table in 2.4). Never removed from the manifest format. New docs describe `subscriptions`. |
| `bridge_changes` | **Keep.** Drift detection is unchanged. The change list is rendered from the feed. "Messages for you" is rendered from the inbox, no longer consumed by being displayed, and points to `bridge_inbox`. `since` keeps its timestamp behaviour against `ts`. |
| `bridge_send_message` | **Deprecate, keep as alias** of `bridge_send` with `intent: "note"`. `inReplyTo: "<repo>/requests/<file>"` is resolved to the bus id when the legacy line carries one. |
| `.context/requests/` | **Stop writing by default.** Existing files stay and remain readable with `bridge_get_from`. Optional `messaging.archive: true` in the manifest keeps a sender-side copy for git history. |
| Auto-adding `requests` to `exposes` | **Remove** (G4). Bodies on the bus make it unnecessary. |
| `changelogCursor`, `lastCheckedAt` | **Read once** to seed the `_legacy` cursor, then left alone. |
| `registrationNotice()` | **Keep and extend**: also names the bus consequence ("cannot send or receive messages"). |

### 4.2 Compatibility with bridges that are not upgraded yet

Windows and each distro may run different checkouts for a while.

- **Old sender, new recipient.** The old bridge appends `type: "message"` to `changelog.jsonl` and writes the requests file. The new bridge's scan reads the legacy source, turns entries without a `bus` tag into inbox items, and reads the body through `bridge_get_from` as today. If the sender is unreachable, the item says why, with the existing explanatory error.
- **New sender, old recipient.** While `meta.json` has `"legacyDualWrite": true` (the default for one release), `bridge_send` to a single repo also writes the requests file and the old changelog line. The old bridge shows it under "Messages for you" as before.
- **New to new.** Legacy lines carrying `"bus"` are skipped by the scan, so nothing is seen twice.
- **Old bridges and new event kinds.** An old `bridge_changes` only shows entries that match `watches` or have `type === "contract"` (`src/index.ts:2082-2097`), so new line shapes in the changelog do not break it. Receipts are never dual-written.
- **Turning dual-write off** is a human edit of `meta.json` once every environment is upgraded.

### 4.3 Repos that already use it

- A repo with `watches` and no other change sees the same change list and drift report.
- A repo with open messages under the old scheme sees them again once after upgrade, because they were never acknowledged. That is the intended correction of G1; each can be closed with one ack.

## 5. Delivery

Delivery is **pull, on demand**. A message is delivered when the recipient's side asks for its inbox, through the MCP tool or the CLI. The layer does nothing between those calls.

- The server keeps declaring only the `tools` capability, as today (`src/index.ts:1239`) **[code]**. The SDK offers server-initiated notifications (`dist/esm/server/index.d.ts:190-194`) **[sdk]**; this design does not use them.
- No footer on other tools' results, no reminders, no background process, no watching of the folder.

**Out of scope:** how a dev chooses to surface or automate this is their own business. The CLI has stable exit codes and `--json` output, so anything can be built on top of it without the layer knowing.

## 6. Interface: MCP tools and CLI over one core

### 6.1 One operation table

The MCP tools and the CLI must not drift, so neither is written by hand against the bus. One table defines each operation once:

```ts
interface Operation<I, O> {
  name: string;                 // "inbox", "send", "ack", "subscribe"
  description: string;
  input: z.ZodType<I>;          // one schema: MCP inputSchema and CLI flags both derive from it
  run(bus: Bus, input: I): Promise<O>;     // structured result, no formatting
  render(result: O): string;               // shared text rendering
}
```

- The MCP adapter registers `bridge_<name>` for each entry, with the JSON schema derived from `input`.
- The CLI adapter exposes `context-bridge-mcp <name>`, with flags derived from the same `input` (plus the short forms in 6.6).
- Both call `run` then `render`, and both pass the text through the path redactor. `--json` prints the structured result instead (redacted the same way).
- A test walks the table and fails if an operation is missing from either adapter.

### 6.2 `inbox`

One operation for listing, reading and threads.

| Param | Type | Meaning |
|---|---|---|
| `id` | string, optional | Read this message in full. Marks it `seen` and sends a `read` receipt. |
| `thread` | string, optional | Show the whole thread, oldest first. |
| `show` | `"open"` (default), `"all"`, `"sent"` | Which list to show. |
| `limit` | number, optional | Default 20. |

Listing (no `id`):

```
Inbox for voicy: 2 open, 1 waiting on others, 3 feed items

Open
  [m-01JD3K9Q] high  request from vessel: "Adapt to recall contract 2.0"
      thread of 3, expires 2026-11-21 (sender's clock)
  [m-01JD3J11]       question from llm-lite: "Does the shard reader need a lock?"

Waiting on others
  [m-01JD2Z40] request to vessel: "Review streaming API" - accepted by vessel#k3f9

Feed
  vessel/contracts/recall  1.9 -> 2.0: drop legacy cursor field
  facet/skills/palette     0.4.0 -> 0.5.0
```

Reading (`id` given):

```
Message m-01JD3K9Q  from vessel (vessel#k3f9, via tool, unsigned)  to voicy
intent: request  priority: high  thread: m-01JD3K7A (3 messages)

Message body, written by the sender (not by the bridge):
<bridge-message nonce="7c1e">
...body, path-redacted...
</bridge-message nonce="7c1e">
```

The body is **not** a verbatim block. It is not a repo-owned document, so it goes through the redactor like any bridge output.

### 6.3 `send`

| Param | Type | Meaning |
|---|---|---|
| `to` | string or string[] | Repo name(s). Exactly one of `to`, `topic`, `replyTo` is required. |
| `topic` | string | `<owner>/<name>` to publish to. |
| `replyTo` | string | Message id. Sets `to`, `thread` and `intent: "reply"` automatically. |
| `subject` | string | Required unless `replyTo` (defaults to `Re: ...`). 120 characters. |
| `content` | string | Markdown body. 32 KB. |
| `intent` | `note`, `question`, `request` | Default `note`. |
| `priority` | `low`, `normal`, `high` | Default `normal`. |
| `expiresIn` | string, e.g. `"3d"` | Optional. Minimum `1h`. |
| `template` | string | Optional label for requests. |

Returns `Sent m-01JD... to voicy (request, high).` or a refusal that names the reason: unknown repo, sender not registered, not accepted by the recipient's access rules, topic not postable, size cap, duplicate, store ceiling.

### 6.4 `ack`

| Param | Type | Meaning |
|---|---|---|
| `id` | string | Message id. |
| `status` | `accepted`, `declined`, `done` | New state. |
| `note` | string, optional | One line sent back with the receipt. |

Returns the new state and what remains open in that thread.

### 6.5 `subscribe`

| Param | Type | Meaning |
|---|---|---|
| `action` | `add`, `remove`, `list` | Default `list`. |
| `topic` | string | Topic or pattern. Required for `add` and `remove`. |

Edits `subscriptions` in this repo's manifest under a lock (the manifest read-modify-write gets a lock too, fixing G6). `list` shows current subscriptions, including those derived from `watches`, and the topics other repos offer.

A dedicated operation is needed because `bridge_manifest_update` replaces arrays wholesale.

### 6.6 CLI

The binary keeps its current behaviour with no arguments: it starts the MCP server on stdio, so existing registrations are unaffected. With a subcommand it runs one operation and exits.

```
context-bridge-mcp inbox [--show open|all|sent] [--limit N]
context-bridge-mcp read <id>                    # same as: inbox --id <id>
context-bridge-mcp thread <id>                  # same as: inbox --thread <id>
context-bridge-mcp send (--to <repo>[,<repo>] | --topic <owner/name> | --reply <id>)
                        [--subject "..."] [--intent note|question|request]
                        [--priority low|normal|high] [--expires 3d] [--template <label>]
                        (--message "..." | --file body.md | body on stdin)
context-bridge-mcp ack <id> accepted|declined|done [--note "..."]
context-bridge-mcp subscribe [list]
context-bridge-mcp subscribe add <topic>
context-bridge-mcp subscribe remove <topic>
```

| Aspect | Behaviour |
|---|---|
| Which repo | The current directory, walking up to the nearest `.context/`. `--repo <path>` overrides. Honours `CONTEXT_ROOT` and `ECOSYSTEM_ROOT` like the server. |
| Identity | Same rule as the server: the registered entry for that path. Envelopes are marked `via: "cli"`. |
| Output | The same rendered text as the tool. `--json` for the structured result. Both path-redacted. |
| Exit codes | `0` done, `1` refused or not found (reason on stderr), `2` usage error. |
| Start-up | The CLI path does not import the MCP SDK. |
| Help | `context-bridge-mcp help [command]`, generated from the operation table. |

`read` and `thread` are short forms of `inbox`, defined in the table as aliases so they exist in both adapters or neither.

### 6.7 Changes to existing tools

| Tool | Change |
|---|---|
| `bridge_discover` | Each repo also lists its declared topics and whether it accepts messages from this repo. |
| `bridge_changes` | As in 4.1. |
| `bridge_send_message` | Alias; description marked deprecated. |
| `bridge_register` | No schema change in phase 1. Phase 2 records the repo's public key here. |

18 tools become 22, then 21 when the alias is retired.

### 6.8 Companion skills

The skills document how to use the tools when the dev asks. They do not say when an agent should check or send on its own, or how it should react to what it reads.

| Skill | Change |
|---|---|
| `context-reader` | The "Messages for you" paragraph (line 59) now points to `bridge_inbox` and explains the listing: open items, waiting on others, feed. Adds how to read one message and a thread. No new mandatory step. |
| `context-feeder` | Documents that publishing a contract or skill emits a topic event automatically, and how to address a message to `consumers:<contract>` when asked to notify dependants. |
| `context-bridge` | Rule 6 (lines 101-114) becomes a reference for the four tools and the CLI equivalents: addressing (repo, topic, reply), intents and what each state means, how to close an item, how to subscribe, what each refusal means. Onboarding gains an optional subscriptions step. Notes that message bodies come from other repos and are shown path-redacted. |

`README.md`, `CLAUDE.md` (tool list, the "single file" statement at line 22) and `CONTEXT.md.template` need the same update, plus a CLI section in the README.

## 7. Path to the decentralized network

### 7.1 Phases

| Phase | What | Adds | Does not add |
|---|---|---|---|
| **1. Shared-folder bus** | This document, sections 2 to 6. | Mailboxes, threads, topics, acks, tools, CLI. | Authenticity, multi-machine. |
| **2. Local daemon per environment** | `context-bridge-mcp daemon`, optional. Signing lands in this phase. | Scheduled compaction; the endpoint that phase 3 peers connect to. | A broker. The folder stays the source of truth, so tools and CLI work with the daemon stopped. No delivery role. |
| **3. Peer to peer between machines** | Replicate `bus/log/` between nodes. | Multi-machine. | A server or cloud service. |

Phase 3, concretely:

- **First transport: folder sync.** Point Syncthing (or any file sync) at `bus/log/`. Because every file has exactly one writer, there are no conflicts. State and locks are excluded from sync and stay per machine.
- **Later transport: daemon-to-daemon** over the LAN, exchanging "I have author X up to offset N" and streaming the missing bytes. Same data model; only the copy mechanism changes.
- Addresses become `repo@node`. A bare `repo` resolves when it is unique in the ecosystem.
- Repo paths never leave a machine: `ecosystem.json` is not replicated. A separate `peers.json` carries name, node, public key, exposed topics, and nothing about location.

### 7.2 The transport interface to put in now

The operation table calls a `Bus` core. The core owns state, access rules, store limits and structured results, and talks to storage only through this:

```ts
type Cursor = string;                       // opaque; the fs transport encodes the per-author offsets

interface BusTransport {
  /** Durably publish. Resolves once the envelope is committed. */
  append(envelope: Envelope, body?: Uint8Array): Promise<void>;

  /** Everything after `from`, in a stable order, plus the cursor to resume from. */
  read(from: Cursor | null, limit: number): Promise<{
    items: Envelope[];
    next: Cursor;
    droppedBefore?: string;               // set when retention removed unread history
  }>;

  body(author: string, id: string): Promise<Uint8Array | null>;
}
```

Rules that keep later phases from touching the tools or the CLI:

- Cursors are opaque strings outside the transport.
- Envelope ids are globally unique and never derived from position.
- Order is `replyTo` and `lc`, never arrival position.
- State (inbox, feed) is above the transport, per repo, local to the machine.

Implementations: `FsTransport` (phase 1), `LegacyChangelogSource` (read-only, merged in by the core), later `PeerTransport`.

### 7.3 Identity and signing

- **Per-repo Ed25519 keys**, not per-session. Sessions are too short-lived to pin; the session id is a claim inside the signed envelope. Node's built-in `crypto` supports Ed25519, so no dependency is needed (known API, not re-verified for this document).
- **Private key location:** the environment's user config directory, outside the repo (never committed) and outside `ECOSYSTEM_ROOT` (which every repo can read).
- **Public key:** stored in the repo's ecosystem entry at `bridge_register`, which is the human-approved step. Changing a registered key requires the human to re-register. In phase 3 the same key is what a peer pins on first contact.
- **What is signed:** the canonical JSON of the envelope without `sig`, which includes the body's `sha256`. Canonical form: keys sorted, no whitespace, UTF-8.
- **Format v1 already carries `sig` and `body.sha256`**, so turning signing on is not a format change. Readers show `unsigned`, `signed` or `BAD SIGNATURE`; a bad signature is dropped and logged.
- **What it buys on one machine:** protection against mistakes and mislabelled senders (G5), not against a hostile local process. All agents run as the same OS user and could read any key file. Real authenticity starts in phase 3, where a remote machine cannot.

That is why signing is scheduled for phase 2 and not the MVP.

### 7.4 Access rules

These are access settings on data, declared by the human in files they review. They say who may write where; they say nothing about what anyone does with what they read.

| Question | Where it is decided | Default |
|---|---|---|
| May this repo use the bus at all? | `bridge_register`, run at the user's request | No, until registered |
| Who may message me? | Recipient's manifest: `messaging.accept` / `messaging.block` | Any registered repo |
| Who may post to my topic? | Owner's manifest: `topics.<name>.post` | Owner only |
| What do I subscribe to? | My manifest: `subscriptions` (editable through `subscribe`; visible in git) | Contract changes, as today |

Enforcement:

- **On send**, as a courtesy: the sender's side refuses with a clear reason.
- **On receive**, as the authority: the recipient's scan drops envelopes its own rules reject, and topic posts the owner's manifest does not allow.
- In phase 1 this is cooperative. Any process that can write the shared folder can write a log file. Signing plus receive-side checks make it real against other machines in phase 3.

The no-path-leak rule carries over unchanged: envelopes hold repo names only, bodies and listings are redacted on display, and the bus never needs another repo's path.

### 7.5 Protecting the shared store

Revision 1 had guards whose purpose was to restrain agents acting on their own. Under supervised, on-demand use those are policy the layer should not carry. Each guard was re-judged on one question: does it protect the shared store or the integrity of the data?

| Guard | Decision | Why |
|---|---|---|
| Size caps: subject 120 characters, body 32 KB | **Kept** | Bounds disk use and keeps listings and tool output readable. |
| Duplicate suppression: same recipients, subject and body hash as one of the sender's last 50 sends is refused | **Kept** | A retried tool call or a re-run script would otherwise store the same message twice. Data hygiene. |
| Store ceiling: at most 500 envelopes per repo per hour, counted by the sender against its own clock, adjustable in `policy.json` | **Kept, as a single high ceiling** | Stops a looping script or a bug from filling the shared drive. Set far above any supervised use, so it never shapes behaviour. |
| Hop limit per thread, and the `hops` field | **Dropped** | Its only purpose was to stop agents replying to each other unattended. Each send is now a supervised act. Thread depth is still derivable from `replyTo`. |
| Per-recipient and per-priority rate limits | **Dropped** | Same reason: they policed conversation, not storage. |
| "Human turn" reset, automatic-reply rules, Stop-hook guard | **Dropped** | They belonged to the removed push delivery. |
| Receipts are not inbox items | **Kept** | A data-model fact: a receipt is a state change, not a message. |
| `ecosystem/announce` restricted to low priority | **Dropped** | Priority no longer triggers anything, so there is nothing to restrict. |

### 7.6 Data integrity of message content

Message bodies are text from another repo. The layer's obligations are to label that accurately and not let it corrupt the layer's own output. It does not instruct the reader how to treat it.

- **Framing.** A body is returned inside a delimited block with a per-render nonce, after a header line stating who sent it and that the bridge did not write it. Occurrences of the delimiter inside the body are neutralised, so a body cannot pose as bridge output.
- **Listings.** Subjects are stripped of control characters and line breaks and cut to 80 characters, so one subject cannot forge extra listing lines.
- **Origin labelling.** `via: "bridge"` events (generated by code from a real file change) are distinguishable from `tool` and `cli` messages.
- **Redaction.** Bodies and listings pass through `buildPathRedactor` on display, in both the tools and the CLI. `send` also warns the sender when its content contains its own absolute path.
- **No capability transfer.** No operation lets one repo make another repo's bridge do anything except store and show text.

## 8. Risks, MVP, open questions

### 8.1 Risks

| Risk | Mitigation |
|---|---|
| Tools and CLI drift apart | One operation table, both adapters generated from it, a parity test. |
| The server stops being one file | Accepted: `src/bus.ts`, `src/transport-fs.ts`, `src/operations.ts`, `src/cli.ts`. `CLAUDE.md` line 22 must be updated. |
| CLI and bridge sessions write the same state file concurrently | Per-repo lock with short critical sections; scan results are merged after re-reading under the lock. |
| Dual-write period shows a message twice in mixed-version setups | `bus` tag on legacy lines; integration test with an old-format changelog. |
| CLI output leaks a path the tool output would redact | Redaction lives in the shared adapter step; the path-leak test runs against both front ends. |
| Feed loss for dormant repos at compaction | Drift detection is history-independent; the listing reports the gap. Compaction is not in the MVP and is run by the human. |
| CLI resolves the wrong repo when run from a subdirectory or with env overrides | Same resolution code as the server; the listing's first line always names the repo it acted for. |
| drvfs behaviour of exclusive create and append differs from ext4 | The cross-environment test suite (`test/integration/cross_env.test.ts`) gains bus cases. |

### 8.2 Recommended MVP

In scope:

1. Bus core and `FsTransport`: per-author logs, bodies, state file, generalised lock with the G9 fix.
2. Identity from the registered path.
3. The operation table with `inbox`, `send`, `ack`, `subscribe`, exposed as MCP tools and as CLI commands (`inbox`, `read`, `thread`, `send`, `ack`, `subscribe`), with `--json` and exit codes. `bridge_send_message` as alias.
4. Request lifecycle and receipts.
5. Automatic topics from existing mutations; `watches` read as subscriptions; declared topics with `post` rules; `messaging.accept`.
6. `bridge_changes` reshaped; legacy changelog as a read source; dual-write for one release.
7. Store and integrity protections: size caps, duplicate suppression, store ceiling, body framing, redaction.
8. The three skills, `README.md`, `CLAUDE.md`, and tests: unit for transport and scan; integration for two and three bridges; tool/CLI parity; a mixed old/new changelog test; a path-leak test over bodies in both front ends.

Out of scope for the MVP:

- Presence and the `consumers:<contract>` address (phase 1b, small, optional).
- Compaction and retention.
- Signing, daemon, peer replication.
- Any push, reminder or automation (out of scope for the layer altogether, section 5).

Rough size: 1,100 to 1,400 lines of source (transport and scan about 450, bus core and access rules about 300, operation table and rendering about 300, CLI adapter about 200), about 900 lines of tests, plus skill and doc edits. About one focused week for one developer. Compared with revision 1, the hook CLI, footer, digests and behavioural limits are gone and the human CLI and parity test are added, so the total is roughly unchanged.

### 8.3 Decisions (2026-11-19)

| # | Question | Decision |
|---|---|---|
| 1 | Mailbox granularity | **One inbox per repo.** No session addressing. |
| 2 | Message archive | **Bus only.** No copy in the sender's `.context/requests/`; `messaging.archive` is not built. |
| 3 | Upgrade path | **All environments upgrade together.** No dual-write and no `legacyDualWrite` flag. Old `type: "message"` lines in `changelog.jsonl` are still read as legacy inbox items. |
| 4 | Module split | **Yes, as functional and modular as possible.** `src/index.ts` becomes a thin entry point over small modules (paths, fs/locking, ecosystem, manifest, changelog, redaction, tools, bus, operations, CLI). |
| 5 | CLI name | **`beam`**, a second `bin` entry next to `context-bridge-mcp` (which keeps working, with no arguments it still starts the MCP server). |

Sections 4.1 and 4.2 are read with decision 3 applied: the "dual-write" rows and the "new sender, old recipient" case no longer apply.

### 8.4 How the MVP was built (differences from this document)

- **Bridge events stay in `changelog.jsonl` for now.** Only messages and receipts go on the per-author bus logs. Automatic topics (`<repo>/contracts/<domain>`, ...) are a subscription filter over changelog entries, and `bridge_changes` keeps its line cursor, drift detection and tests unchanged. Moving events onto per-author logs (needed before phase 3 replication) is a later step behind `BusTransport`.
- **Feed split.** Changes on automatic topics are shown by `bridge_changes`; posts on declared topics are the feed in `bridge_inbox`, listed once and then marked seen.
- **Directory.** Each repo publishes its declared topics and `messaging` rules to `bus/directory/<repo>.json` from its own sessions, so senders check them without reading another repo's manifest (whose path they must not learn).
- **Ids** are `m-` plus 10 random base-36 characters (no time prefix); any unambiguous prefix works in the tools and the CLI.
- **Identity** from the registered path applies to the bus. Existing tools still sign changelog entries with `currentRepoName()`.
- **Not built yet:** presence, the `consumers:<contract>` address, compaction and retention, signing, daemon, peer replication.

### 8.5 Open questions (later phases)

1. **Presence.** Do you want "a session is open in that repo" shown in `bridge_discover` at all? It is optional and nothing depends on it.
2. **Phase 3 scope.** Which machines, and only your own agents or other people's too? Is folder sync acceptable as the first inter-machine transport?
3. **Shared topics.** Is one built-in `ecosystem/announce` enough, or do you want to define ecosystem-wide topics that no repo owns?
4. **Retention.** Is 90 days for topic history acceptable once compaction exists?
