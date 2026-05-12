/**
 * Scenario C — Watches filter narrows the change feed
 *
 * Repo A declares `watches` in its manifest to subscribe only to specific
 * (repo, domain) pairs. Pre-seed the ecosystem changelog with noisy
 * entries from other repos and verify bridge_changes shows only what
 * matches the watches, hiding the noise.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

describe("Scenario C — Watches filter narrows changes", () => {
  let bridge: BridgeHandle;

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
  });

  it("hides changes from non-watched repos and domains", async () => {
    // Identify local repo as repo-a and declare watches.
    // The filter accepts either a specific domain name (e.g. "users") or a
    // category keyword that maps to a type ("contracts" → all contract
    // changes, "context" → all context changes). Here we use the plural
    // category form to subscribe to ALL of repo-b's contract changes.
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: {
        patch: {
          project: "repo-a",
          watches: {
            "repo-b": ["contracts"],
          },
        },
      },
    });

    // Register repo-a so currentRepoName resolution + watches lookup works
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: {
        name: "repo-a",
        path: bridge.cwd,
        exposes: ["routes"],
      },
    });

    // Pre-seed the changelog with entries from various repos/domains
    const changelogPath = join(bridge.ecoRoot, "changelog.jsonl");
    const entries = [
      // watched: "contracts" matches any contract-type entry from repo-b
      {
        timestamp: "2026-05-10T10:00:00Z",
        repo: "repo-b",
        type: "contract",
        domain: "users",
        component: null,
        summary: "users contract updated",
      },
      // watched: same category, different contract — still matches "contracts"
      {
        timestamp: "2026-05-10T10:02:00Z",
        repo: "repo-b",
        type: "contract",
        domain: "billing",
        component: null,
        summary: "billing contract updated",
      },
      // not watched: type is "context", not "contract" — filtered out
      {
        timestamp: "2026-05-10T10:05:00Z",
        repo: "repo-b",
        type: "context",
        domain: "internal-notes",
        component: "decisions",
        summary: "internal notes changed",
      },
      // not watched: repo-c — entire repo absent from watches map
      {
        timestamp: "2026-05-10T10:10:00Z",
        repo: "repo-c",
        type: "contract",
        domain: "billing",
        component: null,
        summary: "billing contract from non-watched repo",
      },
      // self — own changes never appear in bridge_changes regardless of watches
      {
        timestamp: "2026-05-10T10:15:00Z",
        repo: "repo-a",
        type: "context",
        domain: "routes",
        component: "users",
        summary: "my own change",
      },
    ];
    writeFileSync(
      changelogPath,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8"
    );

    // Read changes — only repo-b contracts should show
    const result = await bridge.client.callTool({
      name: "bridge_changes",
      arguments: {},
    });
    const text = getToolText(result);

    expect(text).toContain("repo-b");
    // Both watched contracts (users, billing from repo-b) should appear
    expect(text).toContain("users");
    expect(text).toContain("billing");
    // The non-watched type (context) from repo-b should NOT appear
    expect(text).not.toContain("internal-notes");
    // repo-c is not in the watches map — entire repo filtered out
    expect(text).not.toContain("repo-c");
    expect(text).not.toContain("non-watched repo");
    // Self-entries are never surfaced regardless of watches
    expect(text).not.toContain("my own change");
  });
});
