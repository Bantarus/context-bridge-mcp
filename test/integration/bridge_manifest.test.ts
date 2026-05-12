import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge, getToolText, type BridgeHandle } from "../helpers/bridge-server.js";

describe("bridge_manifest / bridge_manifest_update", () => {
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

  describe("bridge_manifest (read)", () => {
    it("returns the seeded default manifest", async () => {
      const result = await bridge.client.callTool({
        name: "bridge_manifest",
        arguments: {},
      });
      const parsed = JSON.parse(getToolText(result));
      expect(parsed).toEqual({ version: "1.0", domains: {} });
    });

    it("returns whatever the manifest file currently contains", async () => {
      // Write a richer manifest directly to disk, then read via the tool
      const richManifest = {
        version: "1.0",
        project: "my-api",
        domains: { routes: ["users", "billing"], schemas: ["user"] },
        watches: { "shared-lib": ["events"] },
      };
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(bridge.ctxRoot, "manifest.json"),
        JSON.stringify(richManifest, null, 2),
        "utf-8"
      );
      const result = await bridge.client.callTool({
        name: "bridge_manifest",
        arguments: {},
      });
      expect(JSON.parse(getToolText(result))).toEqual(richManifest);
    });
  });

  describe("bridge_manifest_update (deep-merge patch)", () => {
    it("merges a patch into the existing manifest", async () => {
      await bridge.client.callTool({
        name: "bridge_manifest_update",
        arguments: {
          patch: { domains: { routes: ["users"] } },
        },
      });
      const onDisk = JSON.parse(
        readFileSync(join(bridge.ctxRoot, "manifest.json"), "utf-8")
      );
      expect(onDisk).toEqual({
        version: "1.0",
        domains: { routes: ["users"] },
      });
    });

    it("recursively merges nested objects", async () => {
      // Seed an initial nested manifest
      await bridge.client.callTool({
        name: "bridge_manifest_update",
        arguments: {
          patch: { watches: { "repo-a": ["contracts"] } },
        },
      });
      // Add a new watched repo without losing the first
      await bridge.client.callTool({
        name: "bridge_manifest_update",
        arguments: {
          patch: { watches: { "repo-b": ["schemas"] } },
        },
      });
      const onDisk = JSON.parse(
        readFileSync(join(bridge.ctxRoot, "manifest.json"), "utf-8")
      );
      expect(onDisk.watches).toEqual({
        "repo-a": ["contracts"],
        "repo-b": ["schemas"],
      });
    });

    it("replaces arrays wholesale (does not concatenate)", async () => {
      await bridge.client.callTool({
        name: "bridge_manifest_update",
        arguments: { patch: { domains: { routes: ["users", "billing"] } } },
      });
      await bridge.client.callTool({
        name: "bridge_manifest_update",
        arguments: { patch: { domains: { routes: ["auth"] } } },
      });
      const onDisk = JSON.parse(
        readFileSync(join(bridge.ctxRoot, "manifest.json"), "utf-8")
      );
      expect(onDisk.domains.routes).toEqual(["auth"]);
    });
  });
});
