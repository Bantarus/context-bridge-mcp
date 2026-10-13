import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startBridge,
  getToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";

/**
 * Repos publishing skills (.context/skills/<name>/) and other repos
 * installing them into .claude/skills/ through the bridge.
 */

const PROVIDER = "world-builder-studio";

function skillMd(version: string, body = "Use the assetlib CLI."): string {
  return [
    "---",
    "name: asset-library",
    "description: >",
    "  Find and bring in 3D models from the",
    "  local asset library.",
    "metadata:",
    `  version: ${version}`,
    "  provider: world-builder-studio",
    "---",
    "",
    "# Using the asset library",
    "",
    body,
    "",
  ].join("\n");
}

describe("published skills", () => {
  let bridge: BridgeHandle;
  let providerDir: string;
  let providerSkill: string;

  const call = (name: string, args: Record<string, unknown> = {}) =>
    bridge.client.callTool({ name, arguments: args });
  const text = async (name: string, args: Record<string, unknown> = {}) =>
    getToolText(await call(name, args));
  const consumerManifest = () =>
    JSON.parse(readFileSync(join(bridge.ctxRoot, "manifest.json"), "utf-8"));
  const installedDir = (skill = "asset-library") =>
    join(bridge.cwd, ".claude", "skills", skill);

  function setProviderVersion(version: string, body?: string): void {
    writeFileSync(join(providerSkill, "SKILL.md"), skillMd(version, body));
    const manifestPath = join(providerDir, ".context", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.skills["asset-library"].version = version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  async function registerProvider(exposes = ["contracts", "skills"]): Promise<void> {
    await call("bridge_register", { name: PROVIDER, path: providerDir, exposes });
  }

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
  });

  beforeEach(() => {
    bridge.resetState();
    providerDir = mkdtempSync(join(tmpdir(), "bridge-provider-"));
    providerSkill = join(providerDir, ".context", "skills", "asset-library");
    mkdirSync(join(providerSkill, "bin"), { recursive: true });
    writeFileSync(
      join(providerDir, ".context", "manifest.json"),
      JSON.stringify({
        version: "1.0",
        project: PROVIDER,
        domains: {},
        skills: { "asset-library": { version: "1.0.0", description: "Use the asset library CLI" } },
      })
    );
    writeFileSync(join(providerSkill, "SKILL.md"), skillMd("1.0.0"));
    // CRLF text and a script with an absolute provider path: copied verbatim
    writeFileSync(
      join(providerSkill, "bin", "run.cmd"),
      "@echo off\r\nE:\\assets\\unity-ithappy\\assetlib\\bin\\assetlib.cmd %*\r\n"
    );
    writeFileSync(join(providerSkill, "bin", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    writeFileSync(join(providerSkill, "icon.bin"), Buffer.from([0, 255, 13, 10, 128]));
  });

  // ── Discovery ──

  it("bridge_discover lists each repo's skills with version and description", async () => {
    await registerProvider();
    const list = await text("bridge_discover");
    expect(list).toContain("skill: asset-library 1.0.0 — Use the asset library CLI");

    const detail = JSON.parse(await text("bridge_discover", { name: PROVIDER }));
    expect(detail.skills).toEqual([
      { name: "asset-library", version: "1.0.0", description: "Use the asset library CLI" },
    ]);
  });

  it("falls back to SKILL.md frontmatter when the manifest has no skills entry", async () => {
    writeFileSync(
      join(providerDir, ".context", "manifest.json"),
      JSON.stringify({ version: "1.0", project: PROVIDER, domains: {} })
    );
    await registerProvider();
    const detail = JSON.parse(await text("bridge_discover", { name: PROVIDER }));
    expect(detail.skills[0]).toMatchObject({
      name: "asset-library",
      version: "1.0.0",
      description: "Find and bring in 3D models from the local asset library.",
    });
  });

  // ── Install ──

  it("installs files byte for byte and records the install in the manifest", async () => {
    await registerProvider();
    const out = await text("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" });
    expect(out).toContain(`Installed skill "asset-library" v1.0.0 from ${PROVIDER}`);

    const dest = installedDir();
    expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toBe(skillMd("1.0.0"));
    expect(readFileSync(join(dest, "bin", "run.cmd"))).toEqual(
      readFileSync(join(providerSkill, "bin", "run.cmd"))
    );
    expect(readFileSync(join(dest, "icon.bin"))).toEqual(Buffer.from([0, 255, 13, 10, 128]));
    expect(statSync(join(dest, "bin", "run.sh")).mode & 0o111).not.toBe(0);

    expect(consumerManifest().installedSkills).toEqual({
      "asset-library": { from: PROVIDER, version: "1.0.0" },
    });
  });

  it("refuses to overwrite a skill folder the bridge did not install, unless forced", async () => {
    await registerProvider();
    mkdirSync(installedDir(), { recursive: true });
    writeFileSync(join(installedDir(), "SKILL.md"), "my own skill");

    await expect(
      call("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" })
    ).rejects.toThrow(/not installed by the bridge.*force/);
    expect(readFileSync(join(installedDir(), "SKILL.md"), "utf-8")).toBe("my own skill");

    await call("bridge_install_skill", { repo: PROVIDER, skill: "asset-library", force: true });
    expect(readFileSync(join(installedDir(), "SKILL.md"), "utf-8")).toBe(skillMd("1.0.0"));
  });

  it("only installs from registered repos that expose skills", async () => {
    await expect(
      call("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" })
    ).rejects.toThrow(/not registered in the ecosystem/);

    await registerProvider(["contracts"]);
    await expect(
      call("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" })
    ).rejects.toThrow(/does not expose "skills"/);

    await registerProvider();
    await expect(
      call("bridge_install_skill", { repo: PROVIDER, skill: "nope" })
    ).rejects.toThrow(/does not publish a skill named "nope".*asset-library/);
    expect(existsSync(installedDir("nope"))).toBe(false);
  });

  it("rejects traversal in skill names and the bridge's own skill names", async () => {
    await registerProvider();
    for (const skill of ["../evil", "a/b", "..", ".hidden"]) {
      await expect(
        call("bridge_install_skill", { repo: PROVIDER, skill })
      ).rejects.toThrow(/Invalid skill name/);
      await expect(call("bridge_uninstall_skill", { skill })).rejects.toThrow(/Invalid skill name/);
    }
    await expect(
      call("bridge_install_skill", { repo: PROVIDER, skill: "context-reader" })
    ).rejects.toThrow(/bridge's own skills/);
  });

  // ── Drift + sync ──

  it("reports a provider version bump as drift, and bridge_sync_skills applies it", async () => {
    await registerProvider();
    await call("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" });
    expect(await text("bridge_changes")).not.toMatch(/skill "asset-library"/);

    setProviderVersion("1.1.0", "Now with image search.");
    rmSync(join(providerSkill, "icon.bin"));
    writeFileSync(join(providerSkill, "notes.md"), "new file");

    const changes = await text("bridge_changes");
    expect(changes).toMatch(
      /skill "asset-library": installed v1\.0\.0 from world-builder-studio, provider now publishes v1\.1\.0/
    );

    const sync = await text("bridge_sync_skills");
    expect(sync).toContain("~ asset-library/SKILL.md");
    expect(sync).toContain("+ asset-library/notes.md");
    expect(sync).toContain("- asset-library/icon.bin");
    expect(sync).toContain('skill "asset-library" from world-builder-studio: v1.0.0 -> v1.1.0');
    // The bridge's own skills are still synced in the same call
    expect(existsSync(installedDir("context-reader"))).toBe(true);

    expect(readFileSync(join(installedDir(), "SKILL.md"), "utf-8")).toContain("image search");
    expect(existsSync(join(installedDir(), "icon.bin"))).toBe(false);
    expect(consumerManifest().installedSkills["asset-library"].version).toBe("1.1.0");
    expect(await text("bridge_changes")).not.toMatch(/skill "asset-library"/);

    const again = await text("bridge_sync_skills");
    expect(again).toMatch(/already up to date/);
  });

  it("reports and survives a provider that stops publishing the skill", async () => {
    await registerProvider();
    await call("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" });
    rmSync(providerSkill, { recursive: true });

    expect(await text("bridge_changes")).toMatch(/no longer publishes it/);
    const sync = await text("bridge_sync_skills");
    expect(sync).toMatch(/no longer publishes it — kept the local copy/);
    expect(existsSync(join(installedDir(), "SKILL.md"))).toBe(true);
  });

  // ── Uninstall ──

  it("uninstall removes the folder and manifest entry, but never a non-bridge skill", async () => {
    await registerProvider();
    await call("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" });
    await text("bridge_uninstall_skill", { skill: "asset-library" });
    expect(existsSync(installedDir())).toBe(false);
    expect(consumerManifest().installedSkills).toEqual({});

    mkdirSync(installedDir("asset-search"), { recursive: true });
    await expect(
      call("bridge_uninstall_skill", { skill: "asset-search" })
    ).rejects.toThrow(/not installed by the bridge/);
    expect(existsSync(installedDir("asset-search"))).toBe(true);
  });
});

describe("publishing skills and the changelog", () => {
  let provider: BridgeHandle;
  let consumer: BridgeHandle;
  let shared: string;
  let providerDir: string;

  beforeAll(async () => {
    shared = mkdtempSync(join(tmpdir(), "bridge-shared-eco-"));
    providerDir = mkdtempSync(join(tmpdir(), "bridge-publisher-"));
    mkdirSync(join(providerDir, ".context"), { recursive: true });
    writeFileSync(
      join(providerDir, ".context", "manifest.json"),
      JSON.stringify({ version: "1.0", project: PROVIDER, domains: {} })
    );
    provider = await startBridge({
      cwd: providerDir,
      env: { ECOSYSTEM_ROOT: shared, CONTEXT_ROOT: join(providerDir, ".context") },
    });
    consumer = await startBridge({ env: { ECOSYSTEM_ROOT: shared } });
  });

  afterAll(async () => {
    await provider.close();
    await consumer.close();
    rmSync(shared, { recursive: true, force: true });
    rmSync(providerDir, { recursive: true, force: true });
  });

  const pcall = (name: string, args: Record<string, unknown> = {}) =>
    provider.client.callTool({ name, arguments: args }).then(getToolText);
  const ccall = (name: string, args: Record<string, unknown> = {}) =>
    consumer.client.callTool({ name, arguments: args }).then(getToolText);
  const providerManifest = () =>
    JSON.parse(readFileSync(join(providerDir, ".context", "manifest.json"), "utf-8"));

  it("publish records the version, logs it, and consumers see installed-skill updates", async () => {
    const skillDir = join(providerDir, ".context", "skills", "asset-library");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skillMd("1.0.0"));

    // Not registered yet: publish still works but warns
    expect(await pcall("bridge_publish_skill", { skill: "asset-library" })).toMatch(
      /Published skill "asset-library" v1\.0\.0[\s\S]*not registered/
    );
    expect(providerManifest().skills["asset-library"]).toEqual({
      version: "1.0.0",
      description: "Find and bring in 3D models from the local asset library.",
    });

    await pcall("bridge_register", { name: PROVIDER, path: providerDir, exposes: ["skills"] });
    await ccall("bridge_install_skill", { repo: PROVIDER, skill: "asset-library" });
    await ccall("bridge_changes"); // move the consumer's cursor past the publish

    // Republishing an unchanged version is a no-op in the changelog
    expect(await pcall("bridge_publish_skill", { skill: "asset-library" })).toMatch(
      /already published at v1\.0\.0/
    );

    // Mismatched explicit version is refused
    writeFileSync(join(skillDir, "SKILL.md"), skillMd("1.1.0"));
    await expect(
      provider.client.callTool({
        name: "bridge_publish_skill",
        arguments: { skill: "asset-library", version: "2.0.0" },
      })
    ).rejects.toThrow(/does not match metadata\.version "1\.1\.0"/);

    await pcall("bridge_publish_skill", { skill: "asset-library" });
    const changelog = readFileSync(join(shared, "changelog.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "skill");
    expect(changelog.map((e) => e.summary)).toEqual(["published 1.0.0", "1.0.0 -> 1.1.0"]);

    const changes = await ccall("bridge_changes");
    expect(changes).toContain(`${PROVIDER} updated skill "asset-library"`);
    expect(changes).toContain("1.0.0 -> 1.1.0");
    expect(changes).toMatch(/installed v1\.0\.0 .* provider now publishes v1\.1\.0/);
  });

  it("a version bump through bridge_manifest_update is logged too", async () => {
    await pcall("bridge_manifest_update", {
      patch: { skills: { "asset-library": { version: "1.2.0" } } },
    });
    const last = readFileSync(join(shared, "changelog.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .pop();
    expect(last).toMatchObject({
      repo: PROVIDER,
      type: "skill",
      domain: "asset-library",
      summary: "1.1.0 -> 1.2.0",
    });
  });

  it("refuses to publish a skill without SKILL.md or a version", async () => {
    await expect(
      provider.client.callTool({ name: "bridge_publish_skill", arguments: { skill: "ghost" } })
    ).rejects.toThrow(/No skill at \.context\/skills\/ghost\/SKILL\.md/);

    const dir = join(providerDir, ".context", "skills", "plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: plain\ndescription: x\n---\n");
    await expect(
      provider.client.callTool({ name: "bridge_publish_skill", arguments: { skill: "plain" } })
    ).rejects.toThrow(/No version to publish/);
  });
});
