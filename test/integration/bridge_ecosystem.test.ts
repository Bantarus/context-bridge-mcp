import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

describe("bridge_register / bridge_discover", () => {
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

  describe("bridge_register", () => {
    it("writes an entry into ecosystem.json", async () => {
      await bridge.client.callTool({
        name: "bridge_register",
        arguments: {
          name: "my-api",
          path: bridge.cwd,
          exposes: ["contracts", "routes"],
          stack: "Node.js",
        },
      });
      const eco = JSON.parse(
        readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
      );
      expect(eco.repos["my-api"]).toMatchObject({
        path: bridge.cwd,
        exposes: ["contracts", "routes"],
        stack: "Node.js",
      });
      expect(eco.repos["my-api"].registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("rejects a relative path", async () => {
      await expect(
        bridge.client.callTool({
          name: "bridge_register",
          arguments: {
            name: "bad",
            path: "./some-relative-path",
            exposes: ["contracts"],
          },
        })
      ).rejects.toThrow(/absolute/i);
    });

    it("does not expose the absolute path in its response", async () => {
      const result = await bridge.client.callTool({
        name: "bridge_register",
        arguments: {
          name: "my-api",
          path: bridge.cwd,
          exposes: ["contracts"],
        },
      });
      const text = getToolText(result);
      expect(text).not.toContain(bridge.cwd);
    });

    it("re-registering updates the existing entry", async () => {
      await bridge.client.callTool({
        name: "bridge_register",
        arguments: {
          name: "my-api",
          path: bridge.cwd,
          exposes: ["contracts"],
          stack: "v1",
        },
      });
      await bridge.client.callTool({
        name: "bridge_register",
        arguments: {
          name: "my-api",
          path: bridge.cwd,
          exposes: ["contracts", "routes"],
          stack: "v2",
        },
      });
      const eco = JSON.parse(
        readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
      );
      expect(eco.repos["my-api"].exposes).toEqual(["contracts", "routes"]);
      expect(eco.repos["my-api"].stack).toBe("v2");
    });
  });

  describe("bridge_discover", () => {
    it("lists registered repos without exposing paths", async () => {
      await bridge.client.callTool({
        name: "bridge_register",
        arguments: {
          name: "my-api",
          path: bridge.cwd,
          exposes: ["contracts"],
        },
      });
      const result = await bridge.client.callTool({
        name: "bridge_discover",
        arguments: {},
      });
      const text = getToolText(result);
      expect(text).toContain("my-api");
      expect(text).not.toContain(bridge.cwd);
    });

    it("returns single-repo detail (without path) when name is provided", async () => {
      await bridge.client.callTool({
        name: "bridge_register",
        arguments: {
          name: "my-api",
          path: bridge.cwd,
          exposes: ["contracts", "routes"],
          stack: "Node.js",
        },
      });
      const result = await bridge.client.callTool({
        name: "bridge_discover",
        arguments: { name: "my-api" },
      });
      const text = getToolText(result);
      expect(text).toContain("my-api");
      expect(text).toContain("contracts");
      expect(text).toContain("Node.js");
      expect(text).not.toContain(bridge.cwd);
    });

    it("throws an MCP error for an unknown repo name", async () => {
      await expect(
        bridge.client.callTool({
          name: "bridge_discover",
          arguments: { name: "unknown-repo" },
        })
      ).rejects.toThrow(/not found|no repos/i);
    });
  });
});
