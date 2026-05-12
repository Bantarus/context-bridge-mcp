import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startBridge,
  getToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

describe("bridge_sync_skills", () => {
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

  const SKILLS = ["context-reader", "context-feeder", "context-bridge"];

  it("copies the three companion skills into <cwd>/.claude/skills/", async () => {
    await bridge.client.callTool({
      name: "bridge_sync_skills",
      arguments: {},
    });
    for (const skill of SKILLS) {
      const path = join(bridge.cwd, ".claude", "skills", skill, "SKILL.md");
      expect(existsSync(path)).toBe(true);
    }
  });

  it("first call reports all skill files as added", async () => {
    const result = await bridge.client.callTool({
      name: "bridge_sync_skills",
      arguments: {},
    });
    const text = getToolText(result);
    // The sync output reports added/updated/unchanged; on a clean repo,
    // every file should be reported as added (or at least the SKILL.md of
    // each skill should be present in the output)
    expect(text).toMatch(/added/i);
  });

  it("second call (no source changes) reports everything as unchanged", async () => {
    await bridge.client.callTool({
      name: "bridge_sync_skills",
      arguments: {},
    });
    const result = await bridge.client.callTool({
      name: "bridge_sync_skills",
      arguments: {},
    });
    const text = getToolText(result);
    // After a clean sync, a second sync sees identical files and reports
    // "up to date" — the bridge's idempotent state marker.
    expect(text).toMatch(/up to date|unchanged|no changes/i);
    expect(text).not.toMatch(/Added \(\d+\):/);
    expect(text).not.toMatch(/Updated \(\d+\):/);
  });

  it("reports an updated file when a target file is modified", async () => {
    await bridge.client.callTool({
      name: "bridge_sync_skills",
      arguments: {},
    });
    // Tamper with one of the synced files in the destination
    const targetSkill = join(
      bridge.cwd,
      ".claude",
      "skills",
      "context-reader",
      "SKILL.md"
    );
    const original = readFileSync(targetSkill, "utf-8");
    writeFileSync(targetSkill, original + "\n<!-- tampered -->\n", "utf-8");

    // Next sync should detect the mismatch and overwrite — reporting "updated"
    const result = await bridge.client.callTool({
      name: "bridge_sync_skills",
      arguments: {},
    });
    const text = getToolText(result);
    expect(text).toMatch(/updated|context-reader/i);

    // And the file should be restored to the canonical source content
    expect(readFileSync(targetSkill, "utf-8")).toBe(original);
  });
});
