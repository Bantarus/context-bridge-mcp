import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startBridge, getAllToolText, type BridgeHandle } from "../helpers/bridge-server.js";
import { OPERATIONS, ALIASES } from "../../src/bus/ops.js";

/**
 * The communication layer: messages, receipts, threads, topics and the
 * `beam` CLI over the shared bus. See docs/communication-layer-design.md.
 */

const BEAM = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/beam.js");

function makeRepo(root: string, name: string, extra: Record<string, unknown> = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".context", "contracts"), { recursive: true });
  writeFileSync(
    join(dir, ".context", "manifest.json"),
    JSON.stringify({ version: "1.0", project: name, domains: {}, ...extra })
  );
  return dir;
}

describe("communication layer", () => {
  let root: string;
  let eco: string;
  const dirs: Record<string, string> = {};
  const bridges: Record<string, BridgeHandle> = {};

  const call = async (repo: string, name: string, args: Record<string, unknown> = {}) =>
    getAllToolText(await bridges[repo].client.callTool({ name, arguments: args })).join("\n");
  const fails = (repo: string, name: string, args: Record<string, unknown>) =>
    expect(bridges[repo].client.callTool({ name, arguments: args })).rejects;
  const beam = (repo: string, args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [BEAM, ...args], {
      cwd: join(dirs[repo], ".context"), // a subfolder: beam walks up to the repo
      env: { ...process.env, ECOSYSTEM_ROOT: eco, CONTEXT_ROOT: "" },
      input,
      encoding: "utf-8",
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const firstId = (text: string) => text.match(/\[(m-[0-9a-z]+)\]/)![1];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "bridge-bus-"));
    eco = join(root, "eco");
    for (const name of ["alpha", "beta", "gamma"]) {
      dirs[name] = makeRepo(root, name);
      bridges[name] = await startBridge({
        cwd: dirs[name],
        env: { ECOSYSTEM_ROOT: eco, CONTEXT_ROOT: join(dirs[name], ".context") },
      });
    }
    for (const name of ["alpha", "beta", "gamma"]) {
      await call(name, "bridge_register", { name, path: dirs[name], exposes: ["contracts"] });
    }
  });

  afterAll(async () => {
    for (const b of Object.values(bridges)) await b.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("exposes every operation as a tool and as a CLI command", async () => {
    const { tools } = await bridges.alpha.client.listTools();
    const names = tools.map((t) => t.name);
    const help = beam("alpha", ["help"]).out;
    for (const op of OPERATIONS) {
      expect(names).toContain(`bridge_${op.name}`);
      expect(help).toContain(`beam ${op.name} `);
    }
    for (const alias of ALIASES) {
      const target = OPERATIONS.find((o) => o.name === alias.of)!;
      expect(Object.keys(target.params)).toContain(alias.param);
      expect(help).toContain(`beam ${alias.name} `);
    }
  });

  it("runs a request through read, accepted and done, with receipts back to the sender", async () => {
    const sent = await call("alpha", "bridge_send", {
      to: "beta",
      subject: "Review the streaming API",
      content: "Please look at `stream()`.",
      intent: "request",
      priority: "high",
    });
    const id = sent.match(/Sent (m-[0-9a-z]+) to beta \(request, high\)/)![1];

    expect(await call("beta", "bridge_inbox")).toContain(`[${id}] high  request from alpha: "Review the streaming API"`);
    expect(await call("alpha", "bridge_inbox")).toContain("beta: not read yet");

    const read = await call("beta", "bridge_inbox", { id });
    expect(read).toContain("Please look at `stream()`.");
    expect(read).toMatch(/Message body, written by alpha \(not by the bridge\):\n<bridge-message nonce="[0-9a-f]+">/);
    expect(await call("alpha", "bridge_inbox")).toContain("beta: read");

    await call("beta", "bridge_ack", { id, status: "accepted", note: "on it" });
    expect(await call("alpha", "bridge_inbox")).toMatch(/beta: accepted by beta#[0-9a-f]+ \("on it"\)/);
    // Still open on beta's side until done
    expect(await call("beta", "bridge_inbox")).toContain(`[${id}]`);

    await call("beta", "bridge_ack", { id, status: "done" });
    expect(await call("beta", "bridge_inbox")).not.toContain(`[${id}]`);
    const alpha = await call("alpha", "bridge_inbox");
    expect(alpha).not.toContain("Waiting on others");
    expect(await call("alpha", "bridge_inbox", { show: "sent" })).toMatch(new RegExp(`\\[${id}\\].*beta: done`));
  });

  it("threads replies, and answering a question closes it on the answering side", async () => {
    const q = await call("alpha", "bridge_send", { to: "beta", subject: "Lock needed?", content: "Does the reader need a lock?", intent: "question" });
    const qid = q.match(/Sent (m-[0-9a-z]+)/)![1];
    const reply = await call("beta", "bridge_send", { replyTo: qid, content: "No, it is append-only." });
    expect(reply).toContain(`thread: ${qid}`);
    expect(reply).toContain(`${qid} is now done in this repo's inbox`);

    const rid = firstId(await call("alpha", "bridge_inbox"));
    const thread = await call("alpha", "bridge_inbox", { thread: rid });
    expect(thread).toContain(`Thread ${qid}: 2 messages, oldest first`);
    expect(thread.indexOf("Does the reader need a lock?")).toBeLessThan(thread.indexOf("No, it is append-only."));
    expect(thread).toContain("Subject: Re: Lock needed?");
    expect(await call("alpha", "bridge_inbox", { show: "sent" })).toMatch(new RegExp(`\\[${qid}\\].*beta: replied`));
  });

  it("refuses acks that make no sense", async () => {
    const n = await call("alpha", "bridge_send", { to: "beta", subject: "FYI", content: "just so you know" });
    const id = n.match(/Sent (m-[0-9a-z]+)/)![1];
    await fails("beta", "bridge_ack", { id, status: "accepted" }).toThrow(/Only requests can be accepted/);
    await fails("alpha", "bridge_ack", { id, status: "done" }).toThrow(/not in this repo's inbox/);
    await fails("beta", "bridge_ack", { id: "m-zzzzzz", status: "done" }).toThrow(/No message "m-zzzzzz"/);
    await fails("beta", "bridge_ack", { id, status: "maybe" }).toThrow(/status must be one of accepted, declined, done/);
  });

  it("delivers posts on declared topics to subscribers once, and enforces who may post", async () => {
    await call("alpha", "bridge_manifest_update", {
      patch: { topics: { releases: { description: "Alpha releases" } } },
    });
    const posted = await call("alpha", "bridge_send", { topic: "alpha/releases", subject: "v2.0 is out", content: "Changelog: ..." });
    expect(posted).toContain("on alpha/releases");

    // Not subscribed yet: the post isn't in beta's feed
    expect(await call("beta", "bridge_inbox")).not.toContain("v2.0 is out");
    const subs = await call("beta", "bridge_subscribe", { action: "add", topic: "alpha/releases" });
    expect(subs).toContain("✓ Subscribed to alpha/releases.");
    expect(subs).toContain("alpha/releases (post: owner) — Alpha releases");

    await call("alpha", "bridge_send", { topic: "alpha/releases", subject: "v2.1 is out", content: "Fixes." });
    const feed = await call("beta", "bridge_inbox");
    expect(feed).toMatch(/\[m-[0-9a-z]+\] alpha\/releases from alpha: "v2\.1 is out"/);
    // Listed once
    expect(await call("beta", "bridge_inbox")).not.toContain("v2.1 is out");
    expect(await call("beta", "bridge_inbox", { show: "all" })).toContain("v2.1 is out");

    await fails("beta", "bridge_send", { topic: "alpha/releases", subject: "x", content: "x" }).toThrow(/Only "alpha" may post/);
    await fails("beta", "bridge_send", { topic: "alpha/nope", subject: "x", content: "x" }).toThrow(/does not declare a topic "nope"/);
    await fails("alpha", "bridge_send", { topic: "alpha/contracts", subject: "x", content: "x" }).toThrow(/automatic topic/);

    // The ecosystem-wide topic reaches everyone, no subscription needed
    await call("gamma", "bridge_send", { topic: "ecosystem/announce", subject: "Bus is live", content: "Try bridge_inbox." });
    expect(await call("beta", "bridge_inbox")).toContain('ecosystem/announce from gamma: "Bus is live"');
  });

  it("filters bridge_changes by subscriptions", async () => {
    await call("gamma", "bridge_manifest_update", { patch: { subscriptions: ["alpha/contracts/users"] } });
    await call("gamma", "bridge_changes");
    await call("alpha", "bridge_update_contract", { domain: "users", content: "# Users\n\n## Version\n1.0\n" });
    await call("alpha", "bridge_update_contract", { domain: "orders", content: "# Orders\n\n## Version\n1.0\n" });
    const changes = await call("gamma", "bridge_changes");
    expect(changes).toContain('alpha updated contract "users"');
    expect(changes).not.toContain('"orders"');
  });

  it("honours the recipient's messaging.block", async () => {
    await call("gamma", "bridge_manifest_update", { patch: { messaging: { block: ["alpha"] } } });
    await call("gamma", "bridge_inbox"); // publishes gamma's rules on the bus
    await fails("alpha", "bridge_send", { to: "gamma", subject: "hi", content: "hi" }).toThrow(
      /"gamma" does not accept messages from "alpha"/
    );
    expect(await call("beta", "bridge_send", { to: "gamma", subject: "hi", content: "hi" })).toMatch(/Sent m-/);
  });

  it("caps sizes and enforces the store ceiling", async () => {
    await fails("alpha", "bridge_send", { to: "beta", subject: "x".repeat(121), content: "x" }).toThrow(/limit is 120/);
    await fails("alpha", "bridge_send", { to: "beta", subject: "big", content: "x".repeat(33 * 1024) }).toThrow(/limit is 32768/);
    mkdirSync(join(eco, "bus"), { recursive: true });
    writeFileSync(join(eco, "bus", "policy.json"), JSON.stringify({ maxPerHour: 1 }));
    try {
      await fails("gamma", "bridge_send", { to: "beta", subject: "one more", content: "x" }).toThrow(/Store ceiling reached: 1/);
    } finally {
      rmSync(join(eco, "bus", "policy.json"));
    }
  });

  it("never shows another repo's path, in the tools or the CLI", async () => {
    const sent = await call("alpha", "bridge_send", {
      to: "beta",
      subject: "Where gamma lives",
      content: `gamma is at ${dirs.gamma} and I am at ${dirs.alpha}`,
    });
    const id = sent.match(/Sent (m-[0-9a-z]+)/)![1];
    const tool = await call("beta", "bridge_inbox", { id });
    const cli = beam("beta", ["read", id, "--json"]).out + beam("beta", ["read", id]).out;
    for (const out of [tool, cli]) {
      expect(out).not.toContain(dirs.gamma);
      expect(out).not.toContain(dirs.alpha);
      expect(out).toContain("<repo:gamma>");
    }
  });

  it("works from the CLI: send from stdin or a file, --json, exit codes", async () => {
    const piped = beam("alpha", ["send", "--to", "beta", "--subject", "from stdin", "--intent", "request"], "piped body\n");
    expect(piped.code).toBe(0);
    const id = piped.out.match(/Sent (m-[0-9a-z]+)/)![1];

    const file = join(root, "body.md");
    writeFileSync(file, "body from a file");
    expect(beam("alpha", ["send", "--to", "beta", "--subject", "from file", "--file", file]).code).toBe(0);

    const json = JSON.parse(beam("beta", ["inbox", "--json"]).out);
    const subjects = json.open.map((i: { subject: string }) => i.subject);
    expect(subjects).toEqual(expect.arrayContaining(["from stdin", "from file"]));

    expect(beam("beta", ["read", id]).out).toContain("piped body");
    const ack = beam("beta", ["ack", id, "done", "--note", "thanks"]);
    expect(ack.code).toBe(0);
    expect(await call("alpha", "bridge_inbox", { show: "sent" })).toMatch(/beta: done by beta#[0-9a-f]+ \("thanks"\)/);

    expect(beam("beta", ["ack", "m-nothere", "done"]).code).toBe(1);
    expect(beam("beta", ["frobnicate"]).code).toBe(2);
    expect(beam("beta", ["ack", id]).code).toBe(2);
    expect(beam("beta", ["send", "--to", "alpha", "--bogus", "x"]).code).toBe(2);

    // --repo acts for another repo
    const viaRepo = spawnSync(process.execPath, [BEAM, "inbox", "--repo", dirs.gamma], {
      cwd: root,
      env: { ...process.env, ECOSYSTEM_ROOT: eco, CONTEXT_ROOT: "" },
      encoding: "utf-8",
    });
    expect(viaRepo.stdout).toMatch(/^Inbox for gamma:/);
  });

  it("refuses repos that are not registered, from the CLI too", () => {
    const loose = makeRepo(root, "loose");
    const r = spawnSync(process.execPath, [BEAM, "inbox"], {
      cwd: loose,
      env: { ...process.env, ECOSYSTEM_ROOT: eco, CONTEXT_ROOT: "" },
      encoding: "utf-8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not registered in the ecosystem/);
  });

  it("keeps one writer per log file", () => {
    const alphaLog = readFileSync(join(eco, "bus", "log", "alpha", "000001.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(alphaLog.length).toBeGreaterThan(0);
    expect(alphaLog.every((e) => e.from.repo === "alpha")).toBe(true);
  });
});
