import { randomBytes } from "crypto";

// ─── Envelopes ───────────────────────────────────────────────────────────────
//
// One JSON line per message or receipt on the bus. See
// docs/communication-layer-design.md §2.2.

export const INTENTS = ["note", "question", "request", "reply"] as const;
export const PRIORITIES = ["low", "normal", "high"] as const;
export const ACK_STATES = ["accepted", "declined", "done"] as const;

export type Intent = (typeof INTENTS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type AckState = (typeof ACK_STATES)[number];
/** Recipient-side state of an inbox item. */
export type ItemState = "new" | "seen" | AckState;
/** Sender-side view of one recipient's progress. */
export type ReceiptState = "read" | "replied" | AckState;
export type Via = "tool" | "cli" | "bridge";

export interface Sender {
  repo: string;
  session: string;
  via: Via;
}

interface EnvelopeBase {
  v: 1;
  id: string;
  from: Sender;
  /** Lamport counter: orders envelopes across authors without trusting clocks. */
  lc: number;
  /** Sender's wall clock. Display only. */
  ts: string;
  /** Reserved for phase-2 signing. */
  sig: null;
}

export interface MessageEnvelope extends EnvelopeBase {
  kind: "message";
  to?: string[];
  topic?: string;
  thread: string;
  replyTo?: string;
  subject: string;
  intent: Intent;
  priority: Priority;
  expiresAt?: string;
  template?: string;
  body: { bytes: number; sha256: string };
}

export interface ReceiptEnvelope extends EnvelopeBase {
  kind: "receipt";
  to: string[];
  /** The message this receipt is about. */
  ref: string;
  status: ReceiptState;
  note?: string;
}

export type Envelope = MessageEnvelope | ReceiptEnvelope;

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, typeable, globally unique enough: 10 random base-36 chars (~51 bits). */
export function newId(prefix: "m" | "r"): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % 36];
  return `${prefix}-${out}`;
}

export function newSessionSuffix(): string {
  return randomBytes(2).toString("hex");
}

/** Repo names become directory names on the bus. */
export const BUS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function authorDir(repo: string): string {
  return repo.toLowerCase();
}

/** One-line, control-free text, so it can't forge extra listing lines. */
export function oneLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isEnvelope(x: unknown): x is Envelope {
  const e = x as Partial<Envelope> | null;
  return (
    !!e &&
    e.v === 1 &&
    typeof e.id === "string" &&
    (e.kind === "message" || e.kind === "receipt") &&
    typeof e.from?.repo === "string" &&
    typeof e.lc === "number"
  );
}
