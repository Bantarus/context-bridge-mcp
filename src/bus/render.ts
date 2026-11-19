import { randomBytes } from "crypto";
import type {
  AckResult,
  AnyItem,
  InboxView,
  MessageView,
  SendResult,
  SubscribeView,
  ThreadView,
} from "./core.js";
import { isExpired } from "./core.js";
import type { FeedItem, InboxItem, SentItem } from "./state.js";

// ─── Text rendering (shared by MCP tools and the CLI) ────────────────────────

const day = (ts: string) => ts.slice(0, 10);

function itemFlags(i: { expiresAt?: string }, threadSize: number, now: number): string {
  const flags: string[] = [];
  if (threadSize > 1) flags.push(`thread of ${threadSize}`);
  if (i.expiresAt) {
    flags.push(`${isExpired(i, now) ? "expired" : "expires"} ${day(i.expiresAt)} (sender's clock)`);
  }
  return flags.length > 0 ? `\n      ${flags.join(", ")}` : "";
}

function inboxLine(i: InboxItem, sizes: Record<string, number>, now: number): string {
  const prio = i.priority === "normal" ? "" : `${i.priority}  `;
  const state = i.state === "new" ? "" : ` (${i.state}${i.by ? ` by ${i.by}` : ""})`;
  const legacy = i.legacy ? " [old-style message]" : "";
  return (
    `  [${i.id}] ${prio}${i.intent} from ${i.from}: "${i.subject}"${state}${legacy}` +
    itemFlags(i, sizes[i.thread] ?? 1, now)
  );
}

function sentStatus(s: SentItem): string {
  const parts = (s.to ?? []).map((r) => {
    const st = s.status[r];
    if (!st) return `${r}: not read yet`;
    return `${r}: ${st.state}${st.by && st.state !== "replied" ? ` by ${st.by}` : ""}${st.note ? ` ("${st.note}")` : ""}`;
  });
  return parts.join("; ");
}

function sentLine(s: SentItem): string {
  const target = s.topic ? `on ${s.topic}` : `to ${(s.to ?? []).join(", ")}`;
  const status = s.topic ? "" : ` - ${sentStatus(s)}`;
  return `  [${s.id}] ${s.intent} ${target}: "${s.subject}"${status}`;
}

function feedLine(f: FeedItem): string {
  return `  [${f.id}] ${f.topic} from ${f.from}: "${f.subject}" (${day(f.ts)})`;
}

export function renderInbox(v: InboxView): string {
  const counts = [
    `${v.open.length} open`,
    `${v.waiting.length} waiting on others`,
    `${v.feed.length} ${v.show === "all" ? "recent" : "new"} feed item${v.feed.length === 1 ? "" : "s"}`,
  ];
  const out = [`Inbox for ${v.repo}: ${counts.join(", ")}`];
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push(`${title}\n${lines.join("\n")}`);
  };
  if (v.show === "sent") {
    section("Sent", v.sent.map(sentLine));
  } else {
    section("Open", v.open.map((i) => inboxLine(i, v.threadSizes, v.now)));
    section("Waiting on others", v.waiting.map(sentLine));
    section("Feed", v.feed.map(feedLine));
    section("Closed", v.closed.map((i) => inboxLine(i, v.threadSizes, v.now)));
  }
  if (out.length === 1) out.push("Nothing here.");
  else out.push("Read one with bridge_inbox({ id }) or `beam read <id>`.");
  return out.join("\n\n");
}

/** Neutralise anything in a body that looks like our own delimiter. */
function defang(body: string): string {
  return body.replace(/<(\/?)bridge-message/gi, "<$1bridge‑message");
}

function header(x: AnyItem): string {
  const i = x.item;
  const legacy = x.kind === "inbox" && !!x.item.legacy;
  const origin = [i.session, i.via ? `via ${i.via}` : null, legacy ? "old-style" : "unsigned"]
    .filter(Boolean)
    .join(", ");
  if (x.kind === "sent") {
    const target = x.item.topic ? `on ${x.item.topic}` : `to ${(x.item.to ?? []).join(", ")}`;
    return `Message ${i.id}  sent by this repo (${origin})  ${target}`;
  }
  const target = x.kind === "feed" ? `on ${x.item.topic}` : `to ${x.item.to.join(", ")}`;
  return `Message ${i.id}  from ${i.from} (${origin})  ${target}`;
}

function details(x: AnyItem, threadSize: number): string {
  const parts: string[] = [];
  if (x.kind !== "feed") parts.push(`intent: ${x.item.intent}`, `priority: ${x.item.priority}`);
  if (x.kind === "inbox") parts.push(`state: ${x.item.state}`);
  parts.push(`sent: ${x.item.ts.slice(0, 16).replace("T", " ")} (sender's clock)`);
  if (threadSize > 1) parts.push(`thread: ${x.item.thread} (${threadSize} messages)`);
  if (x.item.replyTo) parts.push(`reply to: ${x.item.replyTo}`);
  if (x.kind === "inbox" && x.item.template) parts.push(`template: ${x.item.template}`);
  if (x.kind === "sent" && !x.item.topic) parts.push(`status: ${sentStatus(x.item)}`);
  return parts.join("  ");
}

export function renderMessage(v: MessageView): string {
  const author = v.ref.kind === "sent" ? "this repo" : v.ref.item.from;
  const head = `${header(v.ref)}\nSubject: ${v.ref.item.subject}\n${details(v.ref, v.threadSize)}`;
  if ("error" in v.body) return `${head}\n\n⚠ Body unavailable: ${v.body.error}`;
  const nonce = randomBytes(2).toString("hex");
  return (
    `${head}\n\nMessage body, written by ${author} (not by the bridge):\n` +
    `<bridge-message nonce="${nonce}">\n${defang(v.body.text).trimEnd()}\n</bridge-message nonce="${nonce}">`
  );
}

export function renderThread(v: ThreadView): string {
  return [
    `Thread ${v.thread}: ${v.messages.length} message${v.messages.length === 1 ? "" : "s"}, oldest first`,
    ...v.messages.map(renderMessage),
  ].join("\n\n────────\n\n");
}

export function renderSend(r: SendResult): string {
  const target = r.topic ? `on ${r.topic}` : `to ${(r.to ?? []).join(", ")}`;
  const lines = [`✓ Sent ${r.id} ${target} (${r.intent}, ${r.priority}).`];
  if (r.thread !== r.id) lines.push(`  thread: ${r.thread}`);
  if (r.closed) lines.push(`  ${r.closed} is now done in this repo's inbox.`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

export function renderAck(r: AckResult): string {
  const lines = [`✓ ${r.item.id} is now ${r.item.state}${r.item.note ? ` ("${r.item.note}")` : ""}.`];
  if (!r.item.legacy) lines.push(`  ${r.item.from} sees this as a receipt.`);
  const others = r.openInThread.filter((i) => i.id !== r.item.id);
  if (others.length > 0) lines.push(`  Still open in this thread: ${others.map((i) => i.id).join(", ")}`);
  return lines.join("\n");
}

export function renderSubscribe(v: SubscribeView): string {
  const lines: string[] = [];
  if (v.action !== "list") {
    lines.push(
      v.changed
        ? `✓ ${v.action === "add" ? "Subscribed to" : "Unsubscribed from"} ${v.topic}.`
        : `Nothing changed: ${v.topic} was ${v.action === "add" ? "already" : "not"} in subscriptions.`
    );
  }
  const list = (title: string, items: string[]) => {
    if (items.length > 0) lines.push(`${title}:\n${items.map((t) => `  ${t}`).join("\n")}`);
  };
  list("Subscriptions", v.subs.explicit);
  list("From watches", v.subs.fromWatches);
  list("Default (no watches or subscriptions declared)", v.subs.defaults);
  list("Always on", v.subs.implicit);
  list(
    "Topics other repos offer",
    v.offered.map((o) => `${o.topic} (post: ${o.decl.post})${o.decl.description ? ` — ${o.decl.description}` : ""}`)
  );
  lines.push("Automatic topics: <repo>/contracts/<domain>, <repo>/skills/<name>, <repo>/context/<domain>, <repo>/manifest");
  return lines.join("\n\n");
}
