import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startBridge,
  getToolText,
  getAllToolText,
  type BridgeHandle,
} from "../helpers/bridge-server.js";
import { makeMockRepo, type MockRepo } from "../helpers/mock-repo.js";

function readEco(ecoRoot: string) {
  return JSON.parse(readFileSync(join(ecoRoot, "ecosystem.json"), "utf-8"));
}

function writeEco(ecoRoot: string, repos: Record<string, unknown>) {
  writeFileSync(
    join(ecoRoot, "ecosystem.json"),
    JSON.stringify({ version: "1.0", repos }, null, 2),
    "utf-8"
  );
}

function writeFileDeep(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

describe("cross-environment (bridge running inside WSL)", () => {
  let bridge: BridgeHandle;
  let fakeMounts: string;
  let drivesRoot: string;
  let distrosRoot: string;
  let repo: MockRepo | undefined;

  beforeAll(async () => {
    fakeMounts = mkdtempSync(join(tmpdir(), "bridge-mounts-"));
    drivesRoot = join(fakeMounts, "drives");
    distrosRoot = join(fakeMounts, "distros");
    bridge = await startBridge({
      env: {
        WSL_DISTRO_NAME: "TestDistro",
        WSL_DRIVES_ROOT: drivesRoot,
        WSL_DISTROS_ROOT: distrosRoot,
      },
    });
  });

  afterAll(async () => {
    await bridge.close();
    rmSync(fakeMounts, { recursive: true, force: true });
  });

  beforeEach(() => {
    bridge.resetState();
    rmSync(drivesRoot, { recursive: true, force: true });
    rmSync(distrosRoot, { recursive: true, force: true });
    repo?.cleanup();
    repo = undefined;
  });

  it("stores a WSL-native path in \\\\wsl.localhost form and reads it back", async () => {
    repo = makeMockRepo("native", { ".context/api/users.md": "# Users API" });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "native", path: repo.path, exposes: ["api"] },
    });
    const stored = readEco(bridge.ecoRoot).repos.native.path;
    expect(stored).toBe(
      `\\\\wsl.localhost\\TestDistro${repo.path.replaceAll("/", "\\")}`
    );

    const result = await bridge.client.callTool({
      name: "bridge_get_from",
      arguments: { repo: "native", domain: "api", component: "users" },
    });
    expect(getToolText(result)).toBe("# Users API");
  });

  it("reads a Windows-drive repo through the drives mount", async () => {
    writeFileDeep(join(drivesRoot, "z", "proj", ".context", "api", "x.md"), "from Z:");
    writeEco(bridge.ecoRoot, {
      winrepo: { path: "Z:\\proj", exposes: ["api"], registeredAt: "2026-01-01" },
    });
    const result = await bridge.client.callTool({
      name: "bridge_get_from",
      arguments: { repo: "winrepo", domain: "api", component: "x" },
    });
    expect(getToolText(result)).toBe("from Z:");
  });

  it("reads another distro's repo through its bind mount", async () => {
    writeFileDeep(
      join(distrosRoot, "OtherDistro", "srv", "app", ".context", "contracts", "billing.md"),
      "# Billing\n\n## Version\n2.0"
    );
    writeEco(bridge.ecoRoot, {
      other: {
        path: "\\\\wsl.localhost\\OtherDistro\\srv\\app",
        exposes: ["contracts"],
        registeredAt: "2026-01-01",
      },
    });
    const result = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "billing" },
    });
    expect(getAllToolText(result)[0]).toMatch(/Resolved from ecosystem repo: other/);
  });

  it("explains how to mount an unreachable distro instead of failing silently", async () => {
    writeEco(bridge.ecoRoot, {
      ghost: {
        path: "\\\\wsl.localhost\\GhostDistro\\srv\\app",
        exposes: ["contracts"],
        registeredAt: "2026-01-01",
      },
    });
    await expect(
      bridge.client.callTool({
        name: "bridge_get_from",
        arguments: { repo: "ghost", domain: "api" },
      })
    ).rejects.toThrow(/GhostDistro.*mount --bind/);

    await expect(
      bridge.client.callTool({
        name: "bridge_get_contract",
        arguments: { domain: "billing" },
      })
    ).rejects.toThrow(/Unreachable from this environment[\s\S]*ghost/);

    const discover = await bridge.client.callTool({
      name: "bridge_discover",
      arguments: { name: "ghost" },
    });
    expect(JSON.parse(getToolText(discover))).toMatchObject({ reachable: false });
  });
});

describe("shared ecosystem between processes", () => {
  let a: BridgeHandle;
  let b: BridgeHandle;
  let shared: string;

  beforeAll(async () => {
    shared = mkdtempSync(join(tmpdir(), "bridge-shared-eco-"));
    a = await startBridge({ env: { ECOSYSTEM_ROOT: shared } });
    b = await startBridge({ env: { ECOSYSTEM_ROOT: shared } });
  });

  afterAll(async () => {
    await a.close();
    await b.close();
    rmSync(shared, { recursive: true, force: true });
  });

  it("does not lose registrations made concurrently by two bridges", async () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? a : b).client.callTool({
        name: "bridge_register",
        arguments: { name: `repo-${i}`, path: `/srv/repo-${i}`, exposes: ["api"] },
      })
    );
    await Promise.all(calls);
    expect(Object.keys(readEco(shared).repos)).toHaveLength(20);
  });
});

describe("ecosystem robustness", () => {
  let bridge: BridgeHandle;
  let other: MockRepo | undefined;

  beforeAll(async () => {
    bridge = await startBridge();
  });

  afterAll(async () => {
    await bridge.close();
  });

  beforeEach(async () => {
    bridge.resetState();
    other?.cleanup();
    other = undefined;
    await bridge.client.callTool({
      name: "bridge_manifest_update",
      arguments: { patch: { project: "me" } },
    });
  });

  it("refuses to overwrite a malformed ecosystem.json", async () => {
    const path = join(bridge.ecoRoot, "ecosystem.json");
    writeFileSync(path, "{ not json", "utf-8");
    await expect(
      bridge.client.callTool({
        name: "bridge_register",
        arguments: { name: "x", path: "/srv/x", exposes: ["api"] },
      })
    ).rejects.toThrow(/malformed/);
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });

  it("keeps pins and cursors when a repo re-registers", async () => {
    writeEco(bridge.ecoRoot, {
      me: {
        path: bridge.cwd,
        exposes: ["api"],
        registeredAt: "2026-01-01",
        changelogCursor: 3,
        consumedVersions: {
          users: { version: "1.0", source: "api", consumedAt: "2026-01-01T00:00:00Z" },
        },
      },
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "me", path: bridge.cwd, exposes: ["api", "contracts"] },
    });
    const entry = readEco(bridge.ecoRoot).repos.me;
    expect(entry.exposes).toEqual(["api", "contracts"]);
    expect(entry.changelogCursor).toBe(3);
    expect(entry.consumedVersions.users.version).toBe("1.0");
  });

  it("reports changelog entries written with a lagging clock", async () => {
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "me", path: bridge.cwd, exposes: ["api"] },
    });
    await bridge.client.callTool({ name: "bridge_changes", arguments: {} });

    // Another environment whose clock is behind appends after our check
    appendFileSync(
      join(bridge.ecoRoot, "changelog.jsonl"),
      JSON.stringify({
        timestamp: "2000-01-01T00:00:00.000Z",
        repo: "skewed-api",
        type: "contract",
        domain: "users",
        component: null,
        summary: "users v2",
      }) + "\n"
    );

    const first = getToolText(
      await bridge.client.callTool({ name: "bridge_changes", arguments: {} })
    );
    expect(first).toContain("skewed-api updated contract");

    const second = getToolText(
      await bridge.client.callTool({ name: "bridge_changes", arguments: {} })
    );
    expect(second).not.toContain("skewed-api");
  });

  it("finds contracts in a registered contractsPath outside .context/", async () => {
    other = makeMockRepo("custom-contracts", {
      "shared/contracts/billing.md": "# Billing\n\n## Version\n1.0",
    });
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: {
        name: "billing-api",
        path: other.path,
        exposes: ["contracts"],
        contractsPath: join(other.path, "shared", "contracts"),
      },
    });
    const result = await bridge.client.callTool({
      name: "bridge_get_contract",
      arguments: { domain: "billing" },
    });
    expect(getAllToolText(result)[1]).toContain("# Billing");
  });

  it("flags unreachable repos in bridge_discover", async () => {
    writeEco(bridge.ecoRoot, {
      winonly: { path: "C:\\work\\app", exposes: ["api"], registeredAt: "2026-01-01" },
    });
    const text = getToolText(
      await bridge.client.callTool({ name: "bridge_discover", arguments: {} })
    );
    expect(text).toMatch(/winonly[\s\S]*unreachable from this environment/);
  });
});

describe("bridge_register with a custom CONTRACTS_ROOT", () => {
  let bridge: BridgeHandle;
  let contracts: string;

  beforeAll(async () => {
    contracts = mkdtempSync(join(tmpdir(), "bridge-custom-contracts-"));
    bridge = await startBridge({ env: { CONTRACTS_ROOT: contracts } });
  });

  afterAll(async () => {
    await bridge.close();
    rmSync(contracts, { recursive: true, force: true });
  });

  it("records contractsPath automatically when registering the current repo", async () => {
    // The harness puts CONTEXT_ROOT at <cwd>/context, so the repo root is cwd
    await bridge.client.callTool({
      name: "bridge_register",
      arguments: { name: "self", path: join(bridge.ctxRoot, ".."), exposes: ["contracts"] },
    });
    expect(readEco(bridge.ecoRoot).repos.self.contractsPath).toBe(contracts);
  });
});
