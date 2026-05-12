import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

describe("bridge_get / bridge_update / bridge_list", () => {
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

  describe("bridge_update", () => {
    it("writes a context file at .context/<domain>/<component>.md", async () => {
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: {
          domain: "api",
          component: "users",
          content: "# Users\n\nUser routes documentation.",
        },
      });
      const onDisk = readFileSync(
        join(bridge.ctxRoot, "api", "users.md"),
        "utf-8"
      );
      expect(onDisk).toBe("# Users\n\nUser routes documentation.");
    });

    it("creates the domain directory if it does not exist", async () => {
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "events", component: "user-events", content: "x" },
      });
      expect(existsSync(join(bridge.ctxRoot, "events"))).toBe(true);
    });

    it("overwrites an existing file", async () => {
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "api", component: "users", content: "v1" },
      });
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "api", component: "users", content: "v2" },
      });
      const onDisk = readFileSync(
        join(bridge.ctxRoot, "api", "users.md"),
        "utf-8"
      );
      expect(onDisk).toBe("v2");
    });
  });

  describe("bridge_get", () => {
    it("reads back a written file", async () => {
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "api", component: "users", content: "ok" },
      });
      const result = await bridge.client.callTool({
        name: "bridge_get",
        arguments: { domain: "api", component: "users" },
      });
      expect(getToolText(result)).toBe("ok");
    });

    it("throws an MCP error when the file is missing", async () => {
      await expect(
        bridge.client.callTool({
          name: "bridge_get",
          arguments: { domain: "api", component: "nope" },
        })
      ).rejects.toThrow(/no file found/i);
    });

    it("returns the directory listing when component is omitted", async () => {
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "api", component: "users", content: "x" },
      });
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "api", component: "billing", content: "x" },
      });
      const result = await bridge.client.callTool({
        name: "bridge_get",
        arguments: { domain: "api" },
      });
      const text = getToolText(result);
      expect(text).toContain("users");
      expect(text).toContain("billing");
    });
  });

  describe("bridge_list", () => {
    it("lists all context files across domains", async () => {
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "api", component: "users", content: "x" },
      });
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "schemas", component: "user", content: "x" },
      });
      const result = await bridge.client.callTool({
        name: "bridge_list",
        arguments: {},
      });
      const text = getToolText(result);
      expect(text).toContain("api/users");
      expect(text).toContain("schemas/user");
    });

    it("filters by domain", async () => {
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "api", component: "users", content: "x" },
      });
      await bridge.client.callTool({
        name: "bridge_update",
        arguments: { domain: "schemas", component: "user", content: "x" },
      });
      const result = await bridge.client.callTool({
        name: "bridge_list",
        arguments: { domain: "api" },
      });
      const text = getToolText(result);
      expect(text).toContain("users");
      expect(text).not.toContain("schemas/user");
    });

    it("returns empty-ish output when no files exist", async () => {
      const result = await bridge.client.callTool({
        name: "bridge_list",
        arguments: {},
      });
      const text = getToolText(result);
      // Should not throw, may include a "no files" marker or empty list
      expect(typeof text).toBe("string");
    });
  });
});
