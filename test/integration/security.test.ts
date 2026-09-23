import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startBridge,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

describe("security — path traversal across tools", () => {
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

  it("bridge_get rejects a domain that escapes the context root", async () => {
    await expect(
      bridge.client.callTool({
        name: "bridge_get",
        arguments: { domain: "../../etc", component: "passwd" },
      })
    ).rejects.toThrow(/escapes allowed roots|path/i);
  });

  it("bridge_list rejects a domain that escapes the context root", async () => {
    await expect(
      bridge.client.callTool({
        name: "bridge_list",
        arguments: { domain: "../../../.." },
      })
    ).rejects.toThrow(/escapes allowed roots/i);
  });

  it("bridge_update rejects a component that escapes the domain", async () => {
    await expect(
      bridge.client.callTool({
        name: "bridge_update",
        arguments: {
          domain: "api",
          component: "../../../../../etc/evil",
          content: "x",
        },
      })
    ).rejects.toThrow(/escapes allowed roots|path/i);
  });

  it("bridge_get_contract rejects a domain with traversal segments", async () => {
    await expect(
      bridge.client.callTool({
        name: "bridge_get_contract",
        arguments: { domain: "../../etc/passwd" },
      })
    ).rejects.toThrow(/escapes allowed roots|path/i);
  });

  it("bridge_get_from rejects a domain/component that escapes the target repo", async () => {
    await expect(
      bridge.client.callTool({
        name: "bridge_get_from",
        arguments: {
          repo: bridge.cwd,
          domain: "../../..",
          component: "etc/passwd",
        },
      })
    ).rejects.toThrow(/escapes allowed roots|path/i);
  });
});
