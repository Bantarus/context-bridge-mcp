import { invalidParams } from "../errors.js";
import type { Bus } from "./core.js";
import { ACK_STATES, INTENTS, PRIORITIES, type AckState } from "./envelope.js";
import {
  renderAck,
  renderInbox,
  renderMessage,
  renderSend,
  renderSubscribe,
  renderThread,
} from "./render.js";

// ─── Operation table ─────────────────────────────────────────────────────────
//
// Each bus operation is defined once — parameters, run, render — and both
// front ends are generated from this table: `bridge_<name>` MCP tools and
// `beam <name>` CLI commands. A test fails if either lacks an operation.

export interface ParamSpec {
  type: "string" | "number" | "string|string[]";
  enum?: readonly string[];
  required?: boolean;
  description: string;
  /** CLI: taken from the n-th positional argument. */
  positional?: number;
  /** CLI: flag name, when it differs from the parameter name. */
  flag?: string;
}

export type Input = Record<string, unknown>;

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** CLI usage line after `beam <name>`. */
  usage: string;
  run(bus: Bus, input: Input): Promise<{ result: unknown; text: string }>;
}

/** CLI short forms: `beam read <id>` is `beam inbox --id <id>`, in both adapters or neither. */
export interface Alias {
  name: string;
  of: string;
  /** The single positional argument fills this parameter. */
  param: string;
  usage: string;
  description: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export const OPERATIONS: Operation[] = [
  {
    name: "inbox",
    description:
      "Check this repo's messages: open items addressed to it, requests it is waiting on, and new posts on " +
      "subscribed topics. Pass id to read one message in full (marks it seen and tells the sender it was " +
      "read), or thread to read a whole conversation. Nothing is consumed by listing: an item stays open " +
      "until it is acknowledged with bridge_ack (a note or reply is done once read).",
    usage: "[--show open|all|sent] [--limit N] [--id <id>] [--thread <id>]",
    params: {
      id: { type: "string", description: "Read this message in full (an unambiguous id prefix works)" },
      thread: { type: "string", description: "Show the whole thread this message belongs to, oldest first" },
      show: {
        type: "string",
        enum: ["open", "all", "sent"],
        description: "open (default): open items, waiting on others, new feed; all: also closed items; sent: what this repo sent",
      },
      limit: { type: "number", description: "Items per section (default 20)" },
    },
    async run(bus, input) {
      if (str(input.id)) {
        const v = await bus.read(str(input.id)!);
        return { result: v, text: renderMessage(v) };
      }
      if (str(input.thread)) {
        const v = await bus.thread(str(input.thread)!);
        return { result: v, text: renderThread(v) };
      }
      const v = await bus.inbox(
        (str(input.show) as "open" | "all" | "sent" | undefined) ?? "open",
        typeof input.limit === "number" ? input.limit : 20
      );
      return { result: v, text: renderInbox(v) };
    },
  },
  {
    name: "send",
    description:
      "Send a message to other ecosystem repos (to), post on a topic (topic), or answer a message (replyTo). " +
      "The body is stored on the shared bus, so recipients in any Windows/WSL environment can read it. " +
      "intent records what you expect back: note (nothing), question (a reply), request (work, then " +
      "accepted/done or declined). Both repos must be registered.",
    usage:
      "(--to <repo>[,<repo>] | --topic <owner/name> | --reply <id>) [--subject \"...\"] " +
      "[--intent note|question|request] [--priority low|normal|high] [--expires 3d] [--template <label>] " +
      "(--message \"...\" | --file body.md | body on stdin)",
    params: {
      to: { type: "string|string[]", description: "Addressee repo name(s)" },
      topic: { type: "string", description: "Topic to post on: <owner>/<name> (or ecosystem/announce)" },
      replyTo: { type: "string", flag: "reply", description: "Id of the message you answer; sets recipients and thread" },
      subject: { type: "string", description: "One line, up to 120 characters. Defaults to 'Re: ...' when replying" },
      content: { type: "string", required: true, flag: "message", description: "Message body (markdown, up to 32 KB)" },
      intent: { type: "string", enum: INTENTS.filter((i) => i !== "reply"), description: "note (default), question or request" },
      priority: { type: "string", enum: PRIORITIES, description: "low, normal (default) or high — sorts listings" },
      expiresIn: { type: "string", flag: "expires", description: "Advisory expiry, e.g. '12h' or '3d' (min 1h)" },
      template: { type: "string", description: "Optional label, e.g. review, adapt-to-contract, bug-report" },
    },
    async run(bus, input) {
      const r = await bus.send({
        to: input.to as string | string[] | undefined,
        topic: str(input.topic),
        replyTo: str(input.replyTo),
        subject: str(input.subject),
        content: str(input.content) ?? "",
        intent: str(input.intent) as "note" | "question" | "request" | undefined,
        priority: str(input.priority) as "low" | "normal" | "high" | undefined,
        expiresIn: str(input.expiresIn),
        template: str(input.template),
      });
      return { result: r, text: renderSend(r) };
    },
  },
  {
    name: "ack",
    description:
      "Acknowledge a message in this repo's inbox: accepted (requests only), done, or declined, with an " +
      "optional one-line note. The sender sees the new state as a receipt in its 'waiting on others' list.",
    usage: "<id> accepted|declined|done [--note \"...\"]",
    params: {
      id: { type: "string", required: true, positional: 0, description: "Message id (or unambiguous prefix)" },
      status: { type: "string", required: true, positional: 1, enum: ACK_STATES, description: "accepted, declined or done" },
      note: { type: "string", description: "One line sent back with the receipt" },
    },
    async run(bus, input) {
      const r = await bus.ack(str(input.id)!, input.status as AckState, str(input.note));
      return { result: r, text: renderAck(r) };
    },
  },
  {
    name: "subscribe",
    description:
      "List, add or remove this repo's topic subscriptions (manifest 'subscriptions'; 'watches' still count). " +
      "Patterns use * for one segment, e.g. 'voicy/contracts/*' or '*/skills/*'. Contract, skill, context " +
      "and manifest changes appear in bridge_changes; posts on declared topics appear in bridge_inbox. " +
      "list also shows the topics other repos offer.",
    usage: "[list] | add <topic> | remove <topic>",
    params: {
      action: { type: "string", positional: 0, enum: ["list", "add", "remove"], description: "list (default), add or remove" },
      topic: { type: "string", positional: 1, description: "Topic or pattern, for add and remove" },
    },
    async run(bus, input) {
      const v = await bus.subscribe(
        (str(input.action) as "list" | "add" | "remove" | undefined) ?? "list",
        str(input.topic)
      );
      return { result: v, text: renderSubscribe(v) };
    },
  },
];

export const ALIASES: Alias[] = [
  { name: "read", of: "inbox", param: "id", usage: "<id>", description: "Read one message in full (inbox --id)" },
  { name: "thread", of: "inbox", param: "thread", usage: "<id>", description: "Read a whole thread (inbox --thread)" },
];

export function findOperation(name: string): Operation | undefined {
  return OPERATIONS.find((o) => o.name === name);
}

/** Check and coerce raw input against an operation's parameters. */
export function validateInput(op: Operation, raw: Input): Input {
  const out: Input = {};
  for (const [key, spec] of Object.entries(op.params)) {
    let v = raw[key];
    if (v === undefined || v === null || v === "") {
      if (spec.required) throw invalidParams(`${op.name}: ${key} is required`);
      continue;
    }
    if (spec.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n <= 0) throw invalidParams(`${op.name}: ${key} must be a positive number`);
      v = Math.floor(n);
    } else if (spec.type === "string|string[]") {
      const ok = typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
      if (!ok) throw invalidParams(`${op.name}: ${key} must be a string or a list of strings`);
    } else if (typeof v !== "string") {
      throw invalidParams(`${op.name}: ${key} must be a string`);
    }
    if (spec.enum && !spec.enum.includes(v as string)) {
      throw invalidParams(`${op.name}: ${key} must be one of ${spec.enum.join(", ")} (got "${v}")`);
    }
    out[key] = v;
  }
  return out;
}

/** JSON Schema for an operation's MCP tool. */
export function jsonSchemaOf(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(op.params)) {
    const base =
      spec.type === "string|string[]"
        ? { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }
        : { type: spec.type };
    properties[key] = { ...base, ...(spec.enum ? { enum: [...spec.enum] } : {}), description: spec.description };
  }
  const required = Object.entries(op.params).filter(([, s]) => s.required).map(([k]) => k);
  return { type: "object", properties, required };
}
