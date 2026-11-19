import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";
import { cfg, ownRepoRoot } from "../config.js";
import { readChangelog } from "../changelog.js";
import { findRepoByPath, readEcosystem, repoRoot } from "../ecosystem.js";
import { invalidParams } from "../errors.js";
import { readJsonFile, safeRead, writeFileAtomic } from "../fsutil.js";
import { readManifest, updateManifest, stringArrayField } from "../manifest.js";
import { assertSafePath } from "../paths.js";
import type { Ecosystem } from "../types.js";
import { accepts, Directory, directoryEntryOf, type DirectoryEntry } from "./directory.js";
import {
  BUS_NAME_RE,
  newId,
  newSessionSuffix,
  oneLine,
  type AckState,
  type Envelope,
  type Intent,
  type ItemState,
  type MessageEnvelope,
  type Priority,
  type ReceiptEnvelope,
  type ReceiptState,
  type Via,
} from "./envelope.js";
import { FsTransport } from "./fs-transport.js";
import { FEED_KEEP, StateStore, type FeedItem, type InboxItem, type RepoState, type SentItem } from "./state.js";
import {
  ANNOUNCE_TOPIC,
  AUTOMATIC_KINDS,
  declaredTopics,
  isSubscribed,
  isValidPattern,
  parseTopic,
  subscriptionsOf,
  type Subscriptions,
  type TopicDecl,
} from "./topics.js";
import type { BusTransport } from "./transport.js";

// ─── Bus core ────────────────────────────────────────────────────────────────
//
// Mechanism only: stores, routes and shows messages when asked. Nothing is
// pushed, nothing runs between calls, and no rule here decides what a reader
// does with what it reads. See docs/communication-layer-design.md.

export const LIMITS = {
  subjectChars: 120,
  bodyBytes: 32 * 1024,
  /** Duplicate suppression looks this many sends back. */
  dedupeWindow: 50,
  /** Store ceiling: envelopes per repo per hour (override in policy.json). */
  maxPerHour: 500,
};

const SESSION_SUFFIX = newSessionSuffix();
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const OPEN_STATES: ItemState[] = ["new", "seen", "accepted"];

export type AnyItem =
  | { kind: "inbox"; item: InboxItem }
  | { kind: "sent"; item: SentItem }
  | { kind: "feed"; item: FeedItem };

// ── Views (structured results, rendered by render.ts) ──

export interface InboxView {
  repo: string;
  show: "open" | "all" | "sent";
  open: InboxItem[];
  waiting: SentItem[];
  feed: FeedItem[];
  closed: InboxItem[];
  sent: SentItem[];
  threadSizes: Record<string, number>;
  now: number;
}

export interface MessageView {
  ref: AnyItem;
  body: { text: string } | { error: string };
  threadSize: number;
}

export interface ThreadView {
  thread: string;
  messages: MessageView[];
}

export interface SendResult {
  id: string;
  to?: string[];
  topic?: string;
  intent: Intent;
  priority: Priority;
  thread: string;
  closed?: string;
  warnings: string[];
}

export interface AckResult {
  item: InboxItem;
  openInThread: InboxItem[];
}

export interface SubscribeView {
  action: "list" | "add" | "remove";
  topic?: string;
  changed: boolean;
  subs: Subscriptions;
  offered: Array<{ repo: string; topic: string; decl: TopicDecl }>;
}

export interface SendInput {
  to?: string | string[];
  topic?: string;
  replyTo?: string;
  subject?: string;
  content: string;
  intent?: Exclude<Intent, "reply">;
  priority?: Priority;
  expiresIn?: string;
  template?: string;
}

// ── Helpers ──

function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+)\s*([hd])$/i);
  if (!m) throw invalidParams(`expiresIn must look like "12h" or "3d" (got "${s}")`);
  const ms = Number(m[1]) * (m[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000);
  if (ms < 3_600_000) throw invalidParams("expiresIn must be at least 1h");
  return ms;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

export function isExpired(item: { expiresAt?: string }, now: number): boolean {
  return !!item.expiresAt && Date.parse(item.expiresAt) < now;
}

/** Whether a sent item still waits on any recipient. */
export function isWaiting(item: SentItem): boolean {
  if (item.intent !== "request" && item.intent !== "question") return false;
  const closing: ReceiptState[] =
    item.intent === "question" ? ["replied", "done", "declined"] : ["done", "declined"];
  return (item.to ?? []).some((r) => !closing.includes(item.status[r]?.state as ReceiptState));
}

function allItems(s: RepoState): AnyItem[] {
  return [
    ...Object.values(s.inbox).map((item) => ({ kind: "inbox" as const, item })),
    ...Object.values(s.sent).map((item) => ({ kind: "sent" as const, item })),
    ...s.feed.map((item) => ({ kind: "feed" as const, item })),
  ];
}

/** Find by full id, or by an unambiguous prefix (with or without "m-"). */
export function findItem(s: RepoState, ref: string): AnyItem {
  const items = allItems(s);
  const exact = items.find((x) => x.item.id === ref);
  if (exact) return exact;
  const prefixes = [ref, `m-${ref}`];
  const hits = items.filter((x) => prefixes.some((p) => x.item.id.startsWith(p)));
  const unique = [...new Map(hits.map((h) => [h.item.id, h])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    throw invalidParams(`"${ref}" matches several messages: ${unique.map((h) => h.item.id).join(", ")}`);
  }
  throw invalidParams(`No message "${ref}" in this repo's inbox, sent items or feed`);
}

// ── Bus ──

export class Bus {
  readonly session: string;

  private constructor(
    readonly me: string,
    private readonly via: Via,
    private readonly transport: BusTransport,
    private readonly states: StateStore,
    private readonly directory: Directory,
    private readonly busRoot: string
  ) {
    this.session = `${me}#${SESSION_SUFFIX}`;
  }

  /**
   * Open the bus as the current repo. Identity is the ecosystem entry whose
   * registered path is this repo — not the manifest's `project`, which any
   * repo could set to any name.
   */
  static async open(via: Via): Promise<Bus> {
    const eco = await readEcosystem();
    const me = findRepoByPath(eco, ownRepoRoot());
    if (!me) {
      throw invalidParams(
        "This repo is not registered in the ecosystem, so it can't send or receive messages. " +
          "Ask the user whether to register it (bridge_register), and which domains to expose."
      );
    }
    if (!BUS_NAME_RE.test(me)) {
      throw invalidParams(
        `This repo is registered as "${me}", which can't be used on the bus — re-register it with a name ` +
          'made of letters, digits, ".", "_" and "-"'
      );
    }
    const busRoot = cfg().busRoot;
    await mkdir(busRoot, { recursive: true });
    const meta = join(busRoot, "meta.json");
    if ((await safeRead(meta)) === null) await writeFileAtomic(meta, JSON.stringify({ format: 1 }, null, 2));
    return new Bus(me, via, new FsTransport(busRoot), new StateStore(busRoot), new Directory(busRoot), busRoot);
  }

  private async maxPerHour(): Promise<number> {
    const policy = await readJsonFile<{ maxPerHour?: unknown }>(
      join(this.busRoot, "policy.json"),
      () => invalidParams("bus/policy.json in ECOSYSTEM_ROOT is malformed")
    );
    return typeof policy?.maxPerHour === "number" && policy.maxPerHour > 0
      ? policy.maxPerHour
      : LIMITS.maxPerHour;
  }

  private sender() {
    return { repo: this.me, session: this.session, via: this.via };
  }

  // ── Scan: pull new envelopes into this repo's state ──

  async scan(): Promise<RepoState> {
    const manifest = await readManifest();
    const subs = subscriptionsOf(manifest);
    const mine = directoryEntryOf(manifest);
    await this.directory.publish(this.me, mine);
    const legacy = await this.legacyMessages();

    return this.states.update(this.me, async (state) => {
      const { items, next } = await this.transport.read(state.cursor);
      const owners = new Set(
        items.flatMap((e) => (e.kind === "message" && e.topic ? [e.topic.split("/")[0]] : []))
      );
      const dirs = new Map<string, DirectoryEntry | null>();
      for (const o of owners) dirs.set(o, o === this.me ? mine : await this.directory.get(o));

      for (const e of items) {
        state.lc = Math.max(state.lc, e.lc);
        if (e.from.repo === this.me) continue;
        if (e.kind === "receipt") this.applyReceipt(state, e);
        else this.applyMessage(state, e, subs, mine, dirs);
      }
      for (const item of legacy) {
        if (!state.inbox[item.id] && accepts(mine.messaging, item.from)) state.inbox[item.id] = item;
      }
      state.feed = state.feed.slice(-FEED_KEEP);
      state.cursor = next;
      return state;
    });
  }

  private applyReceipt(state: RepoState, e: ReceiptEnvelope): void {
    if (!e.to.includes(this.me)) return;
    const sent = state.sent[e.ref];
    if (!sent) return;
    sent.status[e.from.repo] = {
      state: e.status,
      by: e.from.session,
      ...(e.note ? { note: e.note } : {}),
      ts: e.ts,
    };
  }

  private applyMessage(
    state: RepoState,
    e: MessageEnvelope,
    subs: Subscriptions,
    mine: DirectoryEntry,
    dirs: Map<string, DirectoryEntry | null>
  ): void {
    if (e.to?.includes(this.me)) {
      // The recipient's own rules are the authority; the sender's check is a courtesy
      if (!accepts(mine.messaging, e.from.repo)) return;
      if (!state.inbox[e.id]) {
        state.inbox[e.id] = {
          id: e.id,
          from: e.from.repo,
          to: e.to,
          subject: oneLine(e.subject).slice(0, LIMITS.subjectChars),
          intent: e.intent,
          priority: e.priority,
          thread: e.thread,
          ...(e.replyTo ? { replyTo: e.replyTo } : {}),
          ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
          ...(e.template ? { template: oneLine(e.template) } : {}),
          lc: e.lc,
          ts: e.ts,
          session: e.from.session,
          via: e.from.via,
          state: "new",
        };
      }
      // A reply answers one of our messages
      const answered = e.replyTo ? state.sent[e.replyTo] : undefined;
      if (answered && !["done", "declined"].includes(answered.status[e.from.repo]?.state ?? "")) {
        answered.status[e.from.repo] = { state: "replied", by: e.from.session, ts: e.ts };
      }
      return;
    }
    if (e.topic && isSubscribed(subs, e.topic) && this.mayPost(e.from.repo, e.topic, dirs)) {
      if (state.feed.some((f) => f.id === e.id)) return;
      state.feed.push({
        id: e.id,
        from: e.from.repo,
        topic: e.topic,
        subject: oneLine(e.subject).slice(0, LIMITS.subjectChars),
        thread: e.thread,
        ...(e.replyTo ? { replyTo: e.replyTo } : {}),
        lc: e.lc,
        ts: e.ts,
        session: e.from.session,
        via: e.from.via,
        seen: false,
      });
    }
  }

  /** Receive-side topic rule. `subscribers` can't be verified here: accepted. */
  private mayPost(sender: string, topic: string, dirs: Map<string, DirectoryEntry | null>): boolean {
    if (topic === ANNOUNCE_TOPIC) return true;
    const parsed = parseTopic(topic);
    if (!parsed || AUTOMATIC_KINDS.includes(parsed.name)) return false;
    if (parsed.owner === sender) return true;
    const decl = dirs.get(parsed.owner)?.topics[parsed.name];
    return decl?.post === "any" || decl?.post === "subscribers";
  }

  /** Old-style messages addressed to this repo in changelog.jsonl. */
  private async legacyMessages(): Promise<InboxItem[]> {
    const { entries } = await readChangelog();
    return entries
      .filter((e) => e.type === "message" && e.to === this.me && e.repo !== this.me && e.component)
      .map((e) => ({
        id: `legacy-${e.line}`,
        from: e.repo,
        to: [this.me],
        subject: oneLine(e.summary).slice(0, LIMITS.subjectChars),
        intent: "note" as const,
        priority: "normal" as const,
        thread: `legacy-${e.line}`,
        lc: 0,
        ts: e.timestamp,
        state: "new" as const,
        legacy: { domain: e.domain, component: e.component! },
      }));
  }

  // ── Listing ──

  /** Open inbox items, priority first — for summaries elsewhere (bridge_changes). */
  async openItems(): Promise<InboxItem[]> {
    const state = await this.scan();
    return Object.values(state.inbox)
      .filter((i) => OPEN_STATES.includes(i.state))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.lc - b.lc);
  }

  async inbox(show: InboxView["show"] = "open", limit = 20): Promise<InboxView> {
    await this.scan();
    const now = Date.now();
    // The feed is informational: listed once, then marked seen
    const { state, unseen } = await this.states.update(this.me, (s) => {
      const unseen = s.feed.filter((f) => !f.seen).map((f) => ({ ...f }));
      if (show === "open") for (const f of s.feed) f.seen = true;
      return { state: s, unseen };
    });
    const feed = show === "all" ? state.feed : show === "open" ? unseen : [];
    const inbox = Object.values(state.inbox);
    const byPriority = (a: InboxItem, b: InboxItem) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.lc - b.lc || a.ts.localeCompare(b.ts);
    const newestFirst = <T extends { lc: number; ts: string }>(a: T, b: T) =>
      b.lc - a.lc || b.ts.localeCompare(a.ts);
    const sent = Object.values(state.sent);
    const threadSizes: Record<string, number> = {};
    for (const x of allItems(state)) threadSizes[x.item.thread] = (threadSizes[x.item.thread] ?? 0) + 1;

    return {
      repo: this.me,
      show,
      open: inbox.filter((i) => OPEN_STATES.includes(i.state)).sort(byPriority).slice(0, limit),
      waiting: sent.filter(isWaiting).sort(newestFirst).slice(0, limit),
      feed: feed.slice(-limit),
      closed: show === "all" ? inbox.filter((i) => !OPEN_STATES.includes(i.state)).sort(newestFirst).slice(0, limit) : [],
      sent: show === "sent" ? sent.sort(newestFirst).slice(0, limit) : [],
      threadSizes,
      now,
    };
  }

  // ── Reading ──

  async read(ref: string): Promise<MessageView> {
    await this.scan();
    const found = findItem(await this.states.read(this.me), ref);
    await this.markRead([found]);
    const state = await this.states.read(this.me);
    const fresh = findItem(state, found.item.id);
    return {
      ref: fresh,
      body: await this.bodyOf(fresh),
      threadSize: allItems(state).filter((x) => x.item.thread === fresh.item.thread).length,
    };
  }

  async thread(ref: string): Promise<ThreadView> {
    await this.scan();
    const root = findItem(await this.states.read(this.me), ref);
    const thread = root.item.thread;
    const members = allItems(await this.states.read(this.me)).filter((x) => x.item.thread === thread);
    await this.markRead(members);
    const state = await this.states.read(this.me);
    const fresh = allItems(state)
      .filter((x) => x.item.thread === thread)
      .sort((a, b) => a.item.lc - b.item.lc || a.item.from.localeCompare(b.item.from) || a.item.ts.localeCompare(b.item.ts));
    const messages: MessageView[] = [];
    for (const x of fresh) messages.push({ ref: x, body: await this.bodyOf(x), threadSize: fresh.length });
    return { thread, messages };
  }

  /** Fetching a body marks a new item seen; a note or reply needs nothing more, so it's done. */
  private async markRead(items: AnyItem[]): Promise<void> {
    const ids = items.filter((x) => x.kind === "inbox" && x.item.state === "new").map((x) => x.item.id);
    const feedIds = items.filter((x) => x.kind === "feed").map((x) => x.item.id);
    if (ids.length === 0 && feedIds.length === 0) return;
    await this.states.update(this.me, async (s) => {
      for (const f of s.feed) if (feedIds.includes(f.id)) f.seen = true;
      for (const id of ids) {
        const item = s.inbox[id];
        if (!item || item.state !== "new") continue;
        const informational = item.intent === "note" || item.intent === "reply";
        item.state = informational ? "done" : "seen";
        item.by = this.session;
        if (!informational && !item.legacy) await this.appendReceipt(s, item, "read");
      }
    });
  }

  private async bodyOf(x: AnyItem): Promise<MessageView["body"]> {
    if (x.kind === "inbox" && x.item.legacy) return this.legacyBody(x.item);
    const author = x.kind === "sent" ? this.me : x.item.from;
    const text = await this.transport.body(author, x.item.id);
    return text === null ? { error: "the message body is missing from the bus" } : { text };
  }

  private async legacyBody(item: InboxItem): Promise<MessageView["body"]> {
    const eco: Ecosystem = await readEcosystem();
    const entry = eco.repos[item.from];
    if (!entry) return { error: `"${item.from}" is no longer registered in the ecosystem` };
    const root = repoRoot(item.from, entry);
    if ("error" in root) return { error: root.error };
    const ctx = join(root.path, ".context");
    const file = join(ctx, item.legacy!.domain, `${item.legacy!.component}.md`);
    assertSafePath(file, [ctx]);
    const text = await safeRead(file);
    return text === null ? { error: `the message file no longer exists in "${item.from}"` } : { text };
  }

  // ── Sending ──

  async send(input: SendInput): Promise<SendResult> {
    const targets = [input.to, input.topic, input.replyTo].filter((x) => x !== undefined && x !== "");
    if (targets.length !== 1) throw invalidParams("Give exactly one of to, topic or replyTo");
    await this.scan();
    const eco = await readEcosystem();
    const manifest = await readManifest();
    const warnings: string[] = [];

    let to: string[] | undefined;
    let topic: string | undefined;
    let thread: string | undefined;
    let replyTo: string | undefined;
    let replySubject: string | undefined;
    let intent: Intent = input.intent ?? "note";

    if (input.replyTo) {
      const found = findItem(await this.states.read(this.me), input.replyTo);
      const it = found.item;
      replyTo = it.id;
      thread = it.thread;
      intent = "reply";
      replySubject = it.subject.startsWith("Re: ") ? it.subject : `Re: ${it.subject}`;
      if (found.kind === "sent") {
        to = found.item.to;
        topic = found.item.topic;
      } else {
        to = [it.from];
      }
    } else if (input.topic) {
      topic = input.topic;
    } else {
      to = (Array.isArray(input.to) ? input.to : String(input.to).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (to) await this.checkRecipients(to, eco, warnings);
    if (topic) await this.checkTopic(topic, eco, manifest);

    const subject = oneLine(input.subject ?? replySubject ?? "");
    if (!subject) throw invalidParams("subject is required (except when replying)");
    if (subject.length > LIMITS.subjectChars) {
      throw invalidParams(`subject is ${subject.length} characters; the limit is ${LIMITS.subjectChars}`);
    }
    const content = input.content ?? "";
    if (!content.trim()) throw invalidParams("content is empty");
    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > LIMITS.bodyBytes) {
      throw invalidParams(`content is ${bytes} bytes; the limit is ${LIMITS.bodyBytes} — send a summary and point to a file`);
    }
    if (content.includes(ownRepoRoot())) {
      warnings.push("the content contains this repo's absolute path; recipients see it as written");
    }
    const expiresAt = input.expiresIn
      ? new Date(Date.now() + parseDuration(input.expiresIn)).toISOString()
      : undefined;
    const priority = input.priority ?? "normal";
    const hash = sha256(JSON.stringify([to ?? null, topic ?? null, subject, content]));
    const maxPerHour = await this.maxPerHour();

    return this.states.update(this.me, async (s) => {
      const now = Date.now();
      if (s.recent.slice(-LIMITS.dedupeWindow).some((r) => r.hash === hash)) {
        throw invalidParams("Duplicate: this repo already sent the same subject and content to the same address");
      }
      if (s.recent.filter((r) => now - r.at < 3_600_000).length >= maxPerHour) {
        throw invalidParams(
          `Store ceiling reached: ${maxPerHour} messages from this repo in the last hour (bus/policy.json maxPerHour)`
        );
      }
      const id = newId("m");
      s.lc += 1;
      const env: MessageEnvelope = {
        v: 1,
        id,
        kind: "message",
        from: this.sender(),
        ...(to ? { to } : { topic }),
        thread: thread ?? id,
        ...(replyTo ? { replyTo } : {}),
        subject,
        intent,
        priority,
        ...(expiresAt ? { expiresAt } : {}),
        ...(input.template ? { template: oneLine(input.template).slice(0, 40) } : {}),
        lc: s.lc,
        ts: new Date(now).toISOString(),
        body: { bytes, sha256: sha256(content) },
        sig: null,
      };
      await this.transport.append(env, content);
      s.sent[id] = {
        id,
        from: this.me,
        ...(to ? { to } : { topic }),
        subject,
        intent,
        priority,
        thread: env.thread,
        ...(replyTo ? { replyTo } : {}),
        lc: env.lc,
        ts: env.ts,
        session: this.session,
        via: this.via,
        status: {},
      };
      s.recent = [...s.recent, { hash, at: now }].filter(
        (r, i, all) => i >= all.length - LIMITS.dedupeWindow || now - r.at < 3_600_000
      );
      // Answering a note, reply or question closes it on this side
      let closed: string | undefined;
      const answered = replyTo ? s.inbox[replyTo] : undefined;
      if (answered && answered.intent !== "request" && OPEN_STATES.includes(answered.state)) {
        answered.state = "done";
        answered.by = this.session;
        closed = answered.id;
      }
      return { id, to, topic, intent, priority, thread: env.thread, closed, warnings };
    });
  }

  private async checkRecipients(to: string[], eco: Ecosystem, warnings: string[]): Promise<void> {
    if (to.length === 0) throw invalidParams("to is empty");
    for (const r of to) {
      if (!eco.repos[r]) {
        throw invalidParams(`No repo "${r}" in the ecosystem. Registered: ${Object.keys(eco.repos).join(", ")}`);
      }
      if (r === this.me) throw invalidParams("Cannot send a message to this repo itself");
      if (!BUS_NAME_RE.test(r)) throw invalidParams(`Repo "${r}" has a name that can't be used on the bus`);
      const dir = await this.directory.get(r);
      if (dir && !accepts(dir.messaging, this.me)) {
        throw invalidParams(`"${r}" does not accept messages from "${this.me}" (its manifest messaging rules)`);
      }
      if (!dir) warnings.push(`"${r}" hasn't used the bus yet; the message waits until it checks its inbox`);
    }
  }

  private async checkTopic(topic: string, eco: Ecosystem, manifest: Record<string, unknown>): Promise<void> {
    if (topic === ANNOUNCE_TOPIC) return;
    const parsed = parseTopic(topic);
    if (!parsed) throw invalidParams(`Topic must be "<owner>/<name>" (got "${topic}")`);
    if (AUTOMATIC_KINDS.includes(parsed.name)) {
      throw invalidParams(`"${topic}" is an automatic topic: the bridge publishes it from real changes`);
    }
    if (!eco.repos[parsed.owner]) throw invalidParams(`No repo "${parsed.owner}" in the ecosystem`);
    const decl =
      parsed.owner === this.me
        ? declaredTopics(manifest)[parsed.name]
        : (await this.directory.get(parsed.owner))?.topics[parsed.name];
    if (!decl) {
      throw invalidParams(
        parsed.owner === this.me
          ? `Topic "${parsed.name}" is not declared — add it under "topics" in this repo's manifest first`
          : `"${parsed.owner}" does not declare a topic "${parsed.name}"`
      );
    }
    if (parsed.owner === this.me || decl.post === "any") return;
    if (decl.post === "subscribers" && subscriptionsOf(manifest).effective.includes(topic)) return;
    throw invalidParams(
      `Only ${decl.post === "subscribers" ? "subscribers" : `"${parsed.owner}"`} may post to "${topic}"`
    );
  }

  // ── Acknowledging ──

  async ack(ref: string, status: AckState, note?: string): Promise<AckResult> {
    await this.scan();
    const found = findItem(await this.states.read(this.me), ref);
    if (found.kind !== "inbox") {
      throw invalidParams(`"${found.item.id}" is not in this repo's inbox — only received messages can be acknowledged`);
    }
    if (status === "accepted" && found.item.intent !== "request") {
      throw invalidParams(`Only requests can be accepted; mark this ${found.item.intent} done or declined`);
    }
    const cleanNote = note ? oneLine(note).slice(0, 200) : undefined;
    return this.states.update(this.me, async (s) => {
      const item = s.inbox[found.item.id];
      item.state = status;
      item.by = this.session;
      if (cleanNote) item.note = cleanNote;
      else delete item.note;
      if (!item.legacy) await this.appendReceipt(s, item, status, cleanNote);
      const openInThread = Object.values(s.inbox).filter(
        (i) => i.thread === item.thread && OPEN_STATES.includes(i.state)
      );
      return { item: { ...item }, openInThread };
    });
  }

  /** Called inside a state update; takes the author lock (always state, then author). */
  private async appendReceipt(s: RepoState, item: InboxItem, status: ReceiptState, note?: string): Promise<void> {
    s.lc += 1;
    const receipt: ReceiptEnvelope = {
      v: 1,
      id: newId("r"),
      kind: "receipt",
      from: this.sender(),
      to: [item.from],
      ref: item.id,
      status,
      ...(note ? { note } : {}),
      lc: s.lc,
      ts: new Date().toISOString(),
      sig: null,
    };
    await this.transport.append(receipt);
  }

  // ── Subscriptions ──

  async subscribe(action: SubscribeView["action"] = "list", topic?: string): Promise<SubscribeView> {
    let changed = false;
    if (action !== "list") {
      if (!topic) throw invalidParams(`topic is required to ${action} a subscription`);
      if (!isValidPattern(topic)) {
        throw invalidParams(`"${topic}" is not a topic pattern — use "<owner>/<name>", with * for one segment`);
      }
      await updateManifest((m) => {
        const current = stringArrayField(m, "subscriptions");
        const next =
          action === "add"
            ? current.includes(topic) ? current : [...current, topic]
            : current.filter((t) => t !== topic);
        changed = next.length !== current.length;
        if (!changed) return false;
        m.subscriptions = next;
      });
    }
    const manifest = await readManifest();
    await this.directory.publish(this.me, directoryEntryOf(manifest));
    const eco = await readEcosystem();
    const offered: SubscribeView["offered"] = [];
    for (const repo of Object.keys(eco.repos).sort()) {
      if (repo === this.me || !BUS_NAME_RE.test(repo)) continue;
      const dir = await this.directory.get(repo);
      for (const [name, decl] of Object.entries(dir?.topics ?? {})) {
        offered.push({ repo, topic: `${repo}/${name}`, decl });
      }
    }
    return { action, topic, changed, subs: subscriptionsOf(manifest), offered };
  }
}

export async function openBus(via: Via): Promise<Bus> {
  return Bus.open(via);
}

export type { InboxItem, SentItem, FeedItem, Envelope };
