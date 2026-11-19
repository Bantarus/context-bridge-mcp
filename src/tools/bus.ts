import { openBus } from "../bus/core.js";
import { OPERATIONS, jsonSchemaOf, validateInput, type Operation } from "../bus/ops.js";
import { text, type ToolDef } from "../types.js";

// ─── Bus tools, generated from the operation table ───────────────────────────

export const toolName = (op: Operation) => `bridge_${op.name}`;

export function busTool(op: Operation): ToolDef {
  return {
    name: toolName(op),
    description: op.description,
    inputSchema: jsonSchemaOf(op),
    async handler(args) {
      const input = validateInput(op, args ?? {});
      const bus = await openBus("tool");
      const { text: out } = await op.run(bus, input);
      return { content: [text(out)] };
    },
  };
}

export const BUS_TOOLS: ToolDef[] = OPERATIONS.map(busTool);
