import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  getAllToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

describe("bridge_get_contract / bridge_update_contract / bridge_list_contracts", () => {
  let bridge: BridgeHandle;

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
  });

  beforeEach(() => {
    bridge.resetState();
  });

  it("writes a contract to .context/contracts/<domain>.md", async () => {
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: {
        domain: "users",
        content: "# Users contract\n\n## Version\n1.0",
      },
    });
    expect(existsSync(join(bridge.ctxRoot, "contracts", "users.md"))).toBe(
      true
    );
    const onDisk = readFileSync(
      join(bridge.ctxRoot, "contracts", "users.md"),
      "utf-8"
    );
    expect(onDisk).toContain("## Version\n1.0");
  });

  it("reads a local contract back", async () => {
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: { domain: "users", content: "# Users\n\n## Version\n1.0" },
    });
    const result = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    // Local contracts return the raw content directly (no source header)
    const text = getToolText(result);
    expect(text).toContain("# Users");
    expect(text).toContain("## Version");
  });

  it("returns raw content without polluting it with source headers", async () => {
    // The fix for "## Resolved from ecosystem" pollution: local reads
    // must not prepend ANY header to the content, so round-trips are safe.
    const original = "# Users\n\n## Version\n1.0\n";
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: { domain: "users", content: original },
    });
    const result = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    const blocks = getAllToolText(result);
    // Local resolution: only one block, the raw content
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toBe(original);
  });

  it("lists all contracts in the local repo", async () => {
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: { domain: "users", content: "u" },
    });
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: { domain: "billing", content: "b" },
    });
    const result = await bridge.client.callTool({
      name: "bridge_list_contracts",
      arguments: {},
    });
    const text = getToolText(result);
    expect(text).toContain("users");
    expect(text).toContain("billing");
  });

  it("throws an MCP error when a contract is not found anywhere", async () => {
    await expect(
      bridge.client.callTool({
        name: "bridge_get_contract",
        arguments: { domain: "nonexistent" },
      })
    ).rejects.toThrow(/no contract found/i);
  });

  it("bridge_list_contracts returns an empty-ish result when none exist", async () => {
    const result = await bridge.client.callTool({
      name: "bridge_list_contracts",
      arguments: {},
    });
    expect(typeof getToolText(result)).toBe("string");
  });
});
