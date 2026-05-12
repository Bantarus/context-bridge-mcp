import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";
import { makeMockRepo, type MockRepo } from "../helpers/mock-repo.js";

describe("bridge_changes (changelog + drift detection)", () => {
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
  });

  it("appends a changelog entry after bridge_update_contract", async () => {
    await bridge.client.callTool({
      name: "bridge_update_contract",
      arguments: {
        domain: "users",
        content: "# Users\n\n## Version\n1.0",
      },
    });
    const changelogPath = join(bridge.ecoRoot, "changelog.jsonl");
    expect(existsSync(changelogPath)).toBe(true);
    const lines = readFileSync(changelogPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry).toMatchObject({
      type: "contract",
      domain: "users",
    });
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends a changelog entry after bridge_update (context)", async () => {
    await bridge.client.callTool({
      name: "bridge_update",
      arguments: { domain: "api", component: "users", content: "x" },
    });
    const lines = readFileSync(
      join(bridge.ecoRoot, "changelog.jsonl"),
      "utf-8"
    )
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry).toMatchObject({
      type: "context",
      domain: "api",
      component: "users",
    });
  });

  it("bridge_changes returns something callable even with no entries", async () => {
    const result = await bridge.client.callTool({
      name: "bridge_changes",
      arguments: {},
    });
    expect(typeof getToolText(result)).toBe("string");
  });

  it("detects contract version drift after consumption + bump", async () => {
    // Set up other-api repo with users contract at v1.0
    otherRepo = makeMockRepo("other-api", {
      ".context/manifest.json": JSON.stringify({ version: "1.0" }),
      ".context/contracts/users.md": "# Users\n\n## Version\n1.0",
    });

    // Make the current bridge identify itself as "repo-a" via manifest.project
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
        name: "other-api",
        path: otherRepo.path,
        exposes: ["contracts"],
      },
    });

    // Consume the contract — this pins the version in repo-a's ecosystem entry
    await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "users" },
    });

    // Verify the pin
    const eco = JSON.parse(
      readFileSync(join(bridge.ecoRoot, "ecosystem.json"), "utf-8")
    );
    expect(eco.repos["repo-a"].consumedVersions.users).toMatchObject({
      version: "1.0",
      source: "other-api",
    });

    // Bump the contract in other-api to v2.0
    writeFileSync(
      join(otherRepo.path, ".context", "contracts", "users.md"),
      "# Users\n\n## Version\n2.0",
      "utf-8"
    );

    // bridge_changes should now report drift
    const result = await bridge.client.callTool({
      name: "bridge_changes",
      arguments: {},
    });
    const text = getToolText(result);
    expect(text).toMatch(/drift|consumed|1\.0.*2\.0|version/i);
    expect(text).toContain("users");
  });
});
