/**
 * Scenario B — Cross-repo contract drift and recovery
 *
 * Repo A consumes a contract from Repo B. Time passes and B bumps the
 * contract. A starts a new session and sees the drift via bridge_changes,
 * re-reads the contract to pull the new shape, and after that no drift
 * remains. This is the full end-to-end story for the version-tracking
 * feature.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  getAllToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";
import { makeMockRepo, type MockRepo } from "../helpers/mock-repo.js";

describe("Scenario B — Contract drift and recovery", () => {
  let bridge: BridgeHandle;
  let repoB: MockRepo;

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
    if (repoB) repoB.cleanup();
  });

  it("pins on consumption, surfaces drift, then clears it on re-fetch", async () => {
    // ── Setup: repo-a (the bridge) and repo-b (mock with a contract) ────
    repoB = makeMockRepo("repo-b", {
      ".context/manifest.json": JSON.stringify({
        version: "1.0",
        project: "repo-b",
      }),
      ".context/contracts/users.md":
        "# Users\n\n## Version\n1.0\n\n## Endpoints\nGET /users",
    });

    // Identify the local bridge as "repo-a"
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: { patch: { project: "repo-a" } },
    });

    // Register both repos in the ecosystem
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: {
        name: "repo-a",
        path: bridge.cwd,
        exposes: ["routes"],
      },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: {
        name: "repo-b",
        path: repoB.path,
        exposes: ["contracts"],
      },
    });

    // ── Step 1: repo-a consumes repo-b's users contract ──────────────────
    const firstFetch = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    // Ecosystem-resolved reads come back in two text blocks: a header line
    // ("✓ Resolved from ecosystem repo: <name>") and the raw contract body.
    expect(getAllToolText(firstFetch).join("\n")).toMatch(/repo-b/i);

    // The pin should now be recorded in repo-a's ecosystem entry
    const ecoAfterPin = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(ecoAfterPin.repos["repo-a"].consumedVersions.users).toMatchObject({
      version: "1.0",
      source: "repo-b",
    });

    // ── Step 2: repo-b bumps the contract to v2.0 ────────────────────────
    writeFileSync(
      join(repoB.path, ".context", "contracts", "users.md"),
      "# Users\n\n## Version\n2.0\n\n## Endpoints\nGET /users\nDELETE /users/:id",
      "utf-8"
    );

    // ── Step 3: repo-a starts a new session → bridge_changes shows drift ─
    const changesWithDrift = await bridge.client.callTool({
      name: "bridge_changes",
      arguments: {},
    });
    const driftText = getToolText(changesWithDrift);
    expect(driftText).toMatch(/drift|1\.0|2\.0|version/i);
    expect(driftText).toContain("users");

    // ── Step 4: repo-a re-reads the contract → pin updates to v2.0 ───────
    await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });
    const ecoAfterRefetch = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(ecoAfterRefetch.repos["repo-a"].consumedVersions.users.version).toBe(
      "2.0"
    );

    // ── Step 5: bridge_changes no longer reports drift on "users" ────────
    const changesAfterRefetch = await bridge.client.callTool({
      name: "bridge_changes",
      arguments: {},
    });
    const calmText = getToolText(changesAfterRefetch);
    // Drift on "users" specifically should be cleared. The text may still
    // mention changelog activity, but the "1.0 → 2.0" drift line shouldn't
    // be present since the pin caught up.
    expect(calmText).not.toMatch(/1\.0.*2\.0/);
  });
});
