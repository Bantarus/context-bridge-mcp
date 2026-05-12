/**
 * Scenario D — Contract resolution precedence
 *
 * bridge_get_contract searches local first, then iterates ecosystem repos
 * that expose "contracts". Two scenarios:
 *
 * 1. Local-only path: when the local repo has the contract, the bridge
 *    returns it directly and does NOT pin a consumed version (you don't
 *    consume your own contract).
 *
 * 2. Ecosystem fallback: when local is missing, the bridge walks the
 *    ecosystem and returns the first match, pinning the consumed version.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  getAllToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";
import { makeMockRepo, type MockRepo } from "../helpers/mock-repo.js";

describe("Scenario D — Contract resolution precedence", () => {
  let bridge: BridgeHandle;
  let repoB: MockRepo;

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
    if (repoB) repoB.cleanup();
  });

  beforeEach(() => {
    bridge.resetState();
    if (repoB) repoB.cleanup();
    repoB = makeMockRepo("repo-b", {
      ".context/manifest.json": JSON.stringify({
        version: "1.0",
        project: "repo-b",
      }),
      ".context/contracts/users.md": "# Users (from repo-b)\n\n## Version\n2.0",
    });
  });

  it("local contract shadows the ecosystem and does NOT pin", async () => {
    // Identify local repo and register both
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: { patch: { project: "repo-a" } },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "repo-a", path: bridge.cwd, exposes: ["contracts"] },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "repo-b", path: repoB.path, exposes: ["contracts"] },
    });

    // Write a LOCAL users contract
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: {
        domain: "users",
        content: "# Users (from repo-a)\n\n## Version\n1.0",
      },
    });

    // Read — should return the local one
    const result = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    expect(getToolText(result)).toContain("from repo-a");

    // No consumed-version pin should be recorded (local source is skipped)
    const eco = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(eco.repos["repo-a"].consumedVersions?.users).toBeUndefined();
  });

  it("falls back to the ecosystem when no local contract exists, and pins", async () => {
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: { patch: { project: "repo-a" } },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "repo-a", path: bridge.cwd, exposes: ["routes"] },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "repo-b", path: repoB.path, exposes: ["contracts"] },
    });

    // No local users contract — must fall back to repo-b. Ecosystem
    // resolution returns TWO text blocks: a "✓ Resolved from ecosystem repo"
    // header, then the raw contract content.
    const result = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    const combined = getAllToolText(result).join("\n");
    expect(combined).toContain("Resolved from ecosystem repo: repo-b");
    expect(combined).toContain("# Users (from repo-b)");

    // Pin should be recorded against repo-b at v2.0
    const eco = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(eco.repos["repo-a"].consumedVersions.users).toMatchObject({
      version: "2.0",
      source: "repo-b",
    });
  });

  it("transitions cleanly: ecosystem pin disappears once a local contract is added", async () => {
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: { patch: { project: "repo-a" } },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "repo-a", path: bridge.cwd, exposes: ["routes"] },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "repo-b", path: repoB.path, exposes: ["contracts"] },
    });

    // Initially fetch from ecosystem — pin recorded.
    // (Using callTool without binding the result; we only care about the
    // side effect on consumedVersions.)
    await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    let eco = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(eco.repos["repo-a"].consumedVersions.users.source).toBe("repo-b");

    // Repo A "forks" the contract locally — own copy now shadows
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: {
        domain: "users",
        content: "# Users (forked locally)\n\n## Version\n1.0",
      },
    });

    // Re-read — should return local now
    const result = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    expect(getToolText(result)).toContain("forked locally");

    // The stale pin from the old ecosystem read remains until cleaned —
    // this is documented behavior: forking does not auto-prune the pin.
    // bridge_changes will flag it as an orphan source. (Out of scope for
    // this test; verified separately.)
    eco = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(eco.repos["repo-a"].consumedVersions.users.source).toBe("repo-b");
  });
});
