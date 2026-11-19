import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { cfg } from "./config.js";
import { readEcosystem } from "./ecosystem.js";
import { BridgeError } from "./errors.js";
import { writeManifest } from "./manifest.js";
import { buildPathRedactor } from "./redact.js";
import { TOOLS } from "./tools/index.js";
import type { ToolDef } from "./types.js";

// ─── MCP adapter ─────────────────────────────────────────────────────────────

const MCP_CODES: Record<BridgeError["kind"], ErrorCode> = {
  invalid_params: ErrorCode.InvalidParams,
  internal: ErrorCode.InternalError,
  not_found: ErrorCode.InvalidParams,
};

function toMcpError(err: unknown, redact: (t: string) => string): McpError {
  if (err instanceof BridgeError) return new McpError(MCP_CODES[err.kind], redact(err.message));
  if (err instanceof McpError) {
    // McpError prefixes its message with "MCP error <code>: " — strip it so
    // the SDK doesn't add the prefix twice when it serializes.
    const message = err.message.replace(/^MCP error -?\d+: /, "");
    return new McpError(err.code, redact(message), err.data);
  }
  // fs errors carry the full path ("ENOENT: ..., open '/x/y'")
  return new McpError(
    ErrorCode.InternalError,
    redact(err instanceof Error ? err.message : String(err))
  );
}

export function createServer(tools: ToolDef[] = TOOLS): Server {
  const server = new Server(
    { name: "context-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    let redact: (text: string) => string;
    try {
      redact = buildPathRedactor(await readEcosystem());
    } catch {
      redact = buildPathRedactor({ version: "1.0", repos: {} });
    }
    try {
      const tool = byName.get(req.params.name);
      if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
      const result = await tool.handler(req.params.arguments, { redact });
      return {
        ...result,
        content: result.content.map(({ verbatim, ...c }) => ({
          ...c,
          text: verbatim ? c.text : redact(c.text),
        })),
      };
    } catch (err) {
      throw toMcpError(err, redact);
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  const { contextRoot, contractsRoot, manifestPath, ecosystemRoot, ecosystemPath } = cfg();
  await mkdir(contextRoot, { recursive: true });
  if (!existsSync(manifestPath)) {
    await writeManifest({ version: "1.0", domains: {} });
    console.error(`[context-bridge] Initialized manifest at ${manifestPath}`);
  }

  // Ensure ecosystem directory exists
  await mkdir(ecosystemRoot, { recursive: true });

  console.error(`[context-bridge] CONTEXT_ROOT   = ${contextRoot}`);
  console.error(`[context-bridge] CONTRACTS_ROOT = ${contractsRoot}`);
  console.error(`[context-bridge] ECOSYSTEM_PATH = ${ecosystemPath}`);

  await createServer().connect(new StdioServerTransport());
  console.error("[context-bridge] Context Bridge MCP running on stdio");
}
