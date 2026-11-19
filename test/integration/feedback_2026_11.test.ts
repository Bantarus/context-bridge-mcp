import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBridge, getAllToolText, type BridgeHandle } from "../helpers/bridge-server.js";

/**
 * Feedback from vessel and voicy (2026-11-19): unregistered repos, publish
 * checks against the changelog, versioned contract entries, and messages
 * between repos.
 */

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bridge-${name}-`));
  mkdirSync(join(dir, ".context", "contracts"), { recursive: true });
  writeFileSync(
    join(dir, ".context", "manifest.json"),
    JSON.stringify({ version: "1.0", project: name, domains: {} })
  );
  return dir;
}

describe("feedback 2026-11: registration, versions, messages", () => {
  let eco: string;
  let vesselDir: string;
  let voicyDir: string;
  let vessel: BridgeHandle;
  let voicy: BridgeHandle;

  const call = async (b: BridgeHandle, name: string, args: Record<string, unknown> = {}) =>
    getAllToolText(await b.client.callTool({ name, arguments: args })).join("\n");
  const changelog = () =>
    readFileSync(join(eco, "changelog.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  beforeAll(async () => {
    eco = mkdtempSync(join(tmpdir(), "bridge-fb-eco-"));
    vesselDir = makeRepo("vessel");
    voicyDir = makeRepo("voicy");
    const start = (dir: string) =>
      startBridge({ cwd: dir, env: { ECOSYSTEM_ROOT: eco, CONTEXT_ROOT: join(dir, ".context") } });
    vessel = await start(vesselDir);
    voicy = await start(voicyDir);
  });

  afterAll(async () => {
    await vessel.close();
    await voicy.close();
    for (const d of [eco, vesselDir, voicyDir]) rmSync(d, { recursive: true, force: true });
  });

  // ── 1. Unregistered repos say so ──

  it("bridge_manifest and bridge_discover warn while the repo is not registered", async () => {
    expect(await call(vessel, "bridge_manifest")).toMatch(/"vessel"\) is not registered in the ecosystem/);
    expect(await call(vessel, "bridge_discover")).toMatch(/not registered/);

    await call(vessel, "bridge_register", { name: "vessel", path: vesselDir, exposes: ["contracts", "skills"] });
    await call(voicy, "bridge_register", { name: "voicy", path: voicyDir, exposes: ["contracts"] });
    expect(await call(vessel, "bridge_manifest")).not.toMatch(/not registered/);
    expect(await call(vessel, "bridge_discover")).not.toMatch(/not registered/);
  });

  it("warns when the manifest name differs from the registered name", async () => {
    const other = makeRepo("llm-lite");
    const b = await startBridge({
      cwd: other,
      env: { ECOSYSTEM_ROOT: eco, CONTEXT_ROOT: join(other, ".context") },
    });
    try {
      await call(b, "bridge_register", { name: "llm-lite-shard", path: other, exposes: ["contracts"] });
      expect(await call(b, "bridge_manifest")).toMatch(
        /registered in the ecosystem as "llm-lite-shard", but its manifest calls it "llm-lite"/
      );
    } finally {
      await b.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  // ── 4. Skill publish compares with the changelog ──

  it("publishes a skill whose manifest version was edited by hand", async () => {
    const dir = join(vesselDir, ".context", "skills", "vessel-shard");
    mkdirSync(dir, { recursive: true });
    // Legacy changelog entry: version only in the summary
    appendFileSync(
      join(eco, "changelog.jsonl"),
      JSON.stringify({
        timestamp: "2026-11-01T00:00:00Z",
        repo: "vessel",
        type: "skill",
        domain: "vessel-shard",
        component: null,
        summary: "1.3.0 -> 1.4.0",
      }) + "\n"
    );
    // Manifest bumped by hand to 1.9.0 without publishing
    const mPath = join(vesselDir, ".context", "manifest.json");
    const m = JSON.parse(readFileSync(mPath, "utf-8"));
    m.skills = { "vessel-shard": { version: "1.9.0" } };
    writeFileSync(mPath, JSON.stringify(m));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: vessel-shard\nmetadata:\n  version: 1.9.0\n---\n");

    expect(await call(vessel, "bridge_publish_skill", { skill: "vessel-shard" })).toMatch(
      /Published skill "vessel-shard" v1\.9\.0/
    );
    expect(changelog().pop()).toMatchObject({ summary: "1.4.0 -> 1.9.0", version: "1.9.0" });

    expect(await call(vessel, "bridge_publish_skill", { skill: "vessel-shard" })).toMatch(
      /already published at v1\.9\.0/
    );
  });

  // ── 5. Versioned contract entries, in-place edits ──

  it("logs contract updates with versions and the newest changelog line", async () => {
    const contract = (v: string, note: string) =>
      `# Contract: vessel-cli\n\n## Version\n${v}\n\n## Changelog\n- ${note}\n- older entry\n`;
    await call(vessel, "bridge_update_contract", { domain: "vessel-cli", content: contract("1.9", "first") });
    expect(changelog().pop()).toMatchObject({ summary: "1.9: first", version: "1.9" });

    const out = await call(vessel, "bridge_update_contract", {
      domain: "vessel-cli",
      content: contract("1.10", "recall --from <path> without a shard"),
    });
    expect(out).toContain("logged: 1.9 -> 1.10: recall --from <path> without a shard");

    // Edited in place, then logged without resending
    writeFileSync(
      join(vesselDir, ".context", "contracts", "vessel-cli.md"),
      contract("1.11", "adds --json")
    );
    expect(await call(vessel, "bridge_publish_contract", { domain: "vessel-cli" })).toContain(
      "1.10 -> 1.11: adds --json"
    );
    expect(changelog().pop()).toMatchObject({ type: "contract", version: "1.11" });

    await expect(
      vessel.client.callTool({ name: "bridge_publish_contract", arguments: { domain: "nope" } })
    ).rejects.toThrow(/No contract at contracts\/nope\.md/);
  });

  // ── 6. Messages between repos (now on the bus; bridge_send_message is an alias) ──

  it("delivers a message through the bus and keeps it listed until it is read", async () => {
    // voicy watches nothing from vessel: direct messages show regardless
    await call(voicy, "bridge_manifest_update", { patch: { watches: { other: ["contracts"] } } });
    await call(voicy, "bridge_changes"); // move voicy's cursor

    const sent = await call(vessel, "bridge_send_message", {
      to: "voicy",
      subject: "Re: reading the llm-lite shard",
      content: "Use `vessel recall --from <path>`.",
      inReplyTo: "voicy/requests/2026-11-19-to-vessel-shard",
    });
    const id = sent.match(/Sent (m-[0-9a-z]+) to voicy/)![1];
    expect(sent).toContain("deprecated");

    // Nothing written into the sender's repo, nothing exposed without asking
    expect(() => readFileSync(join(vesselDir, ".context", "requests", "x.md"))).toThrow();
    const eco1 = JSON.parse(readFileSync(join(eco, "ecosystem.json"), "utf-8"));
    expect(eco1.repos.vessel.exposes).not.toContain("requests");

    const changes = await call(voicy, "bridge_changes");
    expect(changes).toContain("Messages for you (1 open)");
    expect(changes).toContain(`[${id}] note from vessel: "Re: reading the llm-lite shard"`);
    // Listing doesn't consume it
    expect(await call(voicy, "bridge_changes")).toContain(`[${id}]`);

    const read = await call(voicy, "bridge_inbox", { id });
    expect(read).toContain("vessel recall --from");
    expect(read).toContain("In reply to: voicy/requests/2026-11-19-to-vessel-shard");
    // A note is done once read
    expect(await call(voicy, "bridge_changes")).not.toContain("Messages for you");
  });

  it("an old-style message in changelog.jsonl shows up in the new inbox", async () => {
    mkdirSync(join(vesselDir, ".context", "requests"), { recursive: true });
    writeFileSync(join(vesselDir, ".context", "requests", "2026-11-18-to-voicy-old.md"), "# Old\n\nFrom the old bridge.\n");
    appendFileSync(
      join(eco, "changelog.jsonl"),
      JSON.stringify({
        timestamp: "2026-11-18T10:00:00.000Z",
        repo: "vessel",
        type: "message",
        domain: "requests",
        component: "2026-11-18-to-voicy-old",
        summary: "Old",
        to: "voicy",
      }) + "\n"
    );
    const inbox = await call(voicy, "bridge_inbox");
    const id = inbox.match(/\[(legacy-\d+)\] note from vessel: "Old" \[old-style message\]/)![1];
    expect(await call(voicy, "bridge_inbox", { id })).toContain("From the old bridge.");
  });

  it("refuses the same message twice", async () => {
    await call(vessel, "bridge_send_message", { to: "voicy", subject: "Same", content: "1" });
    await expect(
      vessel.client.callTool({ name: "bridge_send_message", arguments: { to: "voicy", subject: "Same", content: "1" } })
    ).rejects.toThrow(/Duplicate/);
    expect(await call(vessel, "bridge_send_message", { to: "voicy", subject: "Same", content: "2" })).toMatch(/Sent m-/);
  });

  it("refuses unknown addressees and unregistered senders", async () => {
    await expect(
      vessel.client.callTool({
        name: "bridge_send_message",
        arguments: { to: "nobody", subject: "x", content: "x" },
      })
    ).rejects.toThrow(/No repo "nobody" in the ecosystem/);

    const loose = makeRepo("loose");
    const b = await startBridge({ cwd: loose, env: { ECOSYSTEM_ROOT: eco, CONTEXT_ROOT: join(loose, ".context") } });
    try {
      await expect(
        b.client.callTool({ name: "bridge_send_message", arguments: { to: "voicy", subject: "x", content: "x" } })
      ).rejects.toThrow(/not registered in the ecosystem, so it can't send or receive messages/);
    } finally {
      await b.close();
      rmSync(loose, { recursive: true, force: true });
    }
  });
});
