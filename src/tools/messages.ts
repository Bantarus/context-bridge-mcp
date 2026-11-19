import { z } from "zod";
import { openBus } from "../bus/core.js";
import { renderSend } from "../bus/render.js";
import { StateStore } from "../bus/state.js";
import { cfg } from "../config.js";
import { text, type ToolDef } from "../types.js";

// ─── bridge_send_message (deprecated alias of bridge_send) ───────────────────

const SendMessageSchema = z.object({
  to: z.string().min(1),
  subject: z.string().min(1),
  content: z.string().min(1),
  inReplyTo: z.string().min(1).optional(),
});

/**
 * Old replies point at `<repo>/requests/<file>`; map that to the matching
 * old-style inbox item so the reply joins its thread. Anything else is kept
 * as a line in the body.
 */
async function resolveInReplyTo(me: string, ref: string): Promise<string | null> {
  const state = await new StateStore(cfg().busRoot).read(me);
  if (state.inbox[ref] || state.sent[ref]) return ref;
  const m = ref.match(/^([^/]+)\/([^/]+)\/(.+?)(?:\.md)?$/);
  if (!m) return null;
  const hit = Object.values(state.inbox).find(
    (i) => i.from === m[1] && i.legacy?.domain === m[2] && i.legacy.component === m[3]
  );
  return hit?.id ?? null;
}

export const bridgeSendMessage: ToolDef = {
  name: "bridge_send_message",
  description:
    "Deprecated: use bridge_send. Sends a note to another ecosystem repo through the shared bus; the " +
    "addressee reads it with bridge_inbox. Both repos must be registered.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Addressee repo name in the ecosystem" },
      subject: { type: "string", description: "One-line subject" },
      content: { type: "string", description: "Message body (markdown)" },
      inReplyTo: {
        type: "string",
        description: "When replying: the message id you answer (or an old '<repo>/requests/<file>' reference)",
      },
    },
    required: ["to", "subject", "content"],
  },
  async handler(args) {
    const { to, subject, content, inReplyTo } = SendMessageSchema.parse(args);
    const bus = await openBus("tool");
    await bus.scan();
    const replyTo = inReplyTo ? await resolveInReplyTo(bus.me, inReplyTo) : null;
    const result = replyTo
      ? await bus.send({ replyTo, subject, content })
      : await bus.send({
          to,
          subject,
          content: inReplyTo ? `In reply to: ${inReplyTo}\n\n${content}` : content,
        });
    return {
      content: [
        text(
          `${renderSend(result)}\n  ${to} reads it with bridge_inbox. ` +
            "(bridge_send_message is deprecated — use bridge_send.)"
        ),
      ],
    };
  },
};
