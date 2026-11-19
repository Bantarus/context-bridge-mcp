import type { Envelope } from "./envelope.js";

// ─── Transport interface ─────────────────────────────────────────────────────
//
// The bus core talks to storage only through this, so later phases (a local
// daemon, peer replication) swap the transport without touching the tools or
// the CLI. Rules: cursors are opaque outside the transport, ids never derive
// from position, and order comes from `replyTo` and `lc`, never arrival.

export type Cursor = string;

export interface BusTransport {
  /** Durably publish. Resolves once the envelope is committed. */
  append(envelope: Envelope, body?: string): Promise<void>;

  /** Everything after `from`, plus the cursor to resume from. */
  read(from: Cursor | null): Promise<{ items: Envelope[]; next: Cursor }>;

  /** A message body, or null when it is gone. */
  body(author: string, id: string): Promise<string | null>;
}
