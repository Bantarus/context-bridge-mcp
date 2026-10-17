import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { startBridge, getAllToolText, type BridgeHandle } from "../helpers/bridge-server.js";

/**
 * No tool output may reveal where another repo lives: an agent that learns
 * the path can read that repo with its own file tools, bypassing the bridge.
 */
describe("tool output never leaks other repos' absolute paths", () => {
  let bridge: BridgeHandle;
  let otherDir: string;
  const ghostDir = join(tmpdir(), "bridge-ghost-repo-does-not-exist");
  const outputs: string[] = [];
  let documentBlocks: string[] = [];

  async function run(name: string, args: Record<string, unknown> = {}): Promise<void> {
    try {
      const result = await bridge.client.callTool({ name, arguments: args });
      outputs.push(`${name}: ${getAllToolText(result).join("\n")}`);
    } catch (err) {
      outputs.push(`${name} (error): ${(err as Error).message}`);
    }
  }

  function writeContract(version: string): void {
    writeFileSync(
      join(otherDir, ".context", "contracts", "users.md"),
      `# Contract: users\n\n## Version\n${version}\n`
    );
  }

  beforeAll(async () => {
    bridge = await startBridge();
    otherDir = mkdtempSync(join(tmpdir(), "bridge-secret-other-"));
    const skill = join(otherDir, ".context", "skills", "tool");
    mkdirSync(skill, { recursive: true });
    mkdirSync(join(otherDir, ".context", "contracts"), { recursive: true });
    writeFileSync(
      join(otherDir, ".context", "manifest.json"),
      JSON.stringify({ version: "1.0", project: "other", domains: {} })
    );
    writeFileSync(join(skill, "SKILL.md"), "---\nname: tool\nmetadata:\n  version: 1.0.0\n---\n");
    writeContract("1.0");

    // The consumer must be registered for contract pins (drift checks)
    await run("bridge_register", { name: basename(bridge.cwd), path: bridge.cwd, exposes: ["api"] });
    await run("bridge_register", { name: "other", path: otherDir, exposes: ["contracts", "skills"] });
    await run("bridge_register", { name: "ghost", path: ghostDir, exposes: ["contracts", "skills"] });
    await run("bridge_discover");
    await run("bridge_discover", { name: "other" });
    await run("bridge_discover", { name: "ghost" });
    await run("bridge_get_contract", { domain: "users" });
    await run("bridge_get_contract", { domain: "missing" });
    await run("bridge_get_from", { repo: "other", domain: "api", component: "nope" });
    await run("bridge_get_from", { repo: "ghost", domain: "api" });
    await run("bridge_install_skill", { repo: "other", skill: "tool" });
    await run("bridge_install_skill", { repo: "ghost", skill: "tool" });
    await run("bridge_install_skill", { repo: "other", skill: "nope" });

    // Drift against a changed, then an unreachable, provider
    writeContract("2.0");
    await run("bridge_changes");
    renameSync(otherDir, `${otherDir}-moved`);
    await run("bridge_changes");
    await run("bridge_sync_skills");
    await run("bridge_discover");
    renameSync(`${otherDir}-moved`, otherDir);

    // A provider's own document may name its path on purpose (e.g. a CLI
    // consumers run) — that passes through; the bridge's header does not.
    writeFileSync(
      join(otherDir, ".context", "contracts", "cli.md"),
      `# Contract: cli\n\n## Version\n1.0\n\nRun ${join(otherDir, "bin", "tool")}\n`
    );
    documentBlocks = getAllToolText(
      await bridge.client.callTool({ name: "bridge_get_contract", arguments: { domain: "cli" } })
    );

    // Malformed ecosystem.json
    writeFileSync(join(bridge.ecoRoot, "ecosystem.json"), "{ not json");
    await run("bridge_discover");
    await run("bridge_get_contract", { domain: "users" });
  });

  afterAll(async () => {
    await bridge.close();
    rmSync(otherDir, { recursive: true, force: true });
    rmSync(`${otherDir}-moved`, { recursive: true, force: true });
  });

  it("exercised the tools (sanity check)", () => {
    expect(outputs.length).toBe(19);
    const all = outputs.join("\n");
    expect(all).toMatch(/Installed skill "tool"/);
    expect(all).toMatch(/current is v2\.0/);
    expect(all).toMatch(/malformed/);
  });

  it("passes a repo's own documents through verbatim", () => {
    expect(documentBlocks[0]).toBe("✓ Resolved from ecosystem repo: other");
    expect(documentBlocks[1]).toContain(`Run ${join(otherDir, "bin", "tool")}`);
  });

  it("never prints the other repos' paths or the ecosystem location", () => {
    for (const out of outputs) {
      expect(out).not.toContain("bridge-secret-other-");
      expect(out).not.toContain("bridge-ghost-repo-does-not-exist");
      expect(out).not.toContain(bridge.ecoRoot);
    }
  });
});
