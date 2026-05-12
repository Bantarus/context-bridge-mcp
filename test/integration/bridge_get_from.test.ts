import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startBridge,
  getToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";
import { makeMockRepo, type MockRepo } from "../helpers/mock-repo.js";

describe("bridge_get_from (cross-repo reads)", () => {
  let bridge: BridgeHandle;
  let otherRepo: MockRepo;

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
  });

  beforeEach(() => {
    bridge.resetState();
    if (otherRepo) otherRepo.cleanup();
    otherRepo = makeMockRepo("other-api", {
      ".context/manifest.json": JSON.stringify({
        version: "1.0",
        domains: { routes: ["users"] },
      }),
      ".context/routes/users.md": "# Other repo's users routes\n\nGET /users",
    });
  });

  it("reads a context file from another repo by ecosystem name", async () => {
    // Register the other repo so the bridge can resolve the name
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: {
        name: "other-api",
        path: otherRepo.path,
        exposes: ["routes"],
      },
    });
    const result = await bridge.client.callTool({
      name: "bridge_get_from",
      arguments: {
        repo: "other-api",
        domain: "routes",
        component: "users",
      },
    });
    expect(getToolText(result)).toContain("# Other repo's users routes");
  });

  it("reads a context file from another repo by relative path", async () => {
    // No registration needed when passing an absolute/relative path directly
    const result = await bridge.client.callTool({
      name: "bridge_get_from",
      arguments: {
        repo: otherRepo.path,
        domain: "routes",
        component: "users",
      },
    });
    expect(getToolText(result)).toContain("# Other repo's users routes");
  });

  it("throws when the named repo is not registered (treated as path)", async () => {
    await expect(
      bridge.client.callTool({
        name: "bridge_get_from",
        arguments: {
          repo: "not-registered",
          domain: "routes",
          component: "users",
        },
      })
    ).rejects.toThrow(/no file found|not found/i);
  });

  it("throws when the target file does not exist", async () => {
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: {
        name: "other-api",
        path: otherRepo.path,
        exposes: ["routes"],
      },
    });
    await expect(
      bridge.client.callTool({
        name: "bridge_get_from",
        arguments: {
          repo: "other-api",
          domain: "routes",
          component: "billing",
        },
      })
    ).rejects.toThrow(/no file found/i);
  });
});
