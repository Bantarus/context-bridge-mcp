/**
 * Scenario A — Greenfield onboarding
 *
 * A developer starts using context-bridge in a brand-new repo. We walk the
 * full first-day journey: boot the bridge, set the repo identity, register
 * in the ecosystem, install companion skills, declare a domain, and write
 * the first contract. After the journey, every expected file should exist
 * with sensible content.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

describe("Scenario A — Greenfield onboarding", () => {
  let bridge: BridgeHandle;

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
  });

  it("walks the full first-day journey", async () => {
    // 1) Default manifest exists (seeded by helper, mirrors auto-init)
    const initialManifest = JSON.parse(
      readFileSync(join(bridge.ctxRoot, "manifest.json"), "utf-8")
    );
    expect(initialManifest).toEqual({ version: "1.0", domains: {} });

    // 2) Set the repo's identity so currentRepoName resolves predictably
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: { patch: { project: "my-new-repo" } },
    });

    // 3) Register the repo in the ecosystem
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: {
        name: "my-new-repo",
        path: bridge.cwd,
        exposes: ["contracts", "routes"],
        stack: "Node.js",
      },
    });

    const eco = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(eco.repos["my-new-repo"]).toMatchObject({
      path: bridge.cwd,
      exposes: ["contracts", "routes"],
      stack: "Node.js",
    });

    // 4) Install the companion skills so Claude Code knows how to drive the bridge
    await bridge.client.callTool({
      name: "bridge_sync_skills",
      arguments: {},
    });
    for (const skill of ["context-reader", "context-feeder", "context-bridge"]) {
      expect(
        existsSync(join(bridge.cwd, ".claude", "skills", skill, "SKILL.md"))
      ).toBe(true);
    }

    // 5) Declare a domain
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: { patch: { domains: { routes: ["users"] } } },
    });

    // 6) Write the first contract
    const contract = "# Users contract\n\n## Version\n1.0\n\n## Endpoints\nGET /users";
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: { domain: "users", content: contract },
    });

    // 7) Final state — manifest, contract, ecosystem, and skills all populated
    const finalManifest = JSON.parse(
      readFileSync(join(bridge.ctxRoot, "manifest.json"), "utf-8")
    );
    expect(finalManifest).toMatchObject({
      version: "1.0",
      project: "my-new-repo",
      domains: { routes: ["users"] },
    });

    const onDiskContract = readFileSync(
      join(bridge.ctxRoot, "contracts", "users.md"),
      "utf-8"
    );
    expect(onDiskContract).toBe(contract);

    // 8) The changelog records both writes (contract + manifest updates)
    const changelog = readFileSync(
      join(bridge.ecoRoot, "changelog.jsonl"),
      "utf-8"
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const types = changelog.map((e) => e.type);
    expect(types).toContain("contract");
    expect(types).toContain("manifest");
  });
});
