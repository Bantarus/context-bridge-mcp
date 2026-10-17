import { describe, it, expect } from "vitest";
import { buildPathRedactor, type PathEnv } from "../../src/index.js";

const wslUbuntu: PathEnv = {
  platform: "linux",
  wslDistro: "Ubuntu",
  wslDrivesRoot: "/mnt",
  wslDistrosRoot: "/mnt/wsl",
};

const ecosystem = {
  version: "1.0",
  repos: {
    assets: { path: "E:\\assets\\unity-ithappy", exposes: ["skills"], registeredAt: "x" },
    server: {
      path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\server",
      contractsPath: "D:\\shared\\contracts",
      exposes: ["contracts"],
      registeredAt: "x",
    },
    me: { path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\here", exposes: [], registeredAt: "x" },
  },
};

const redact = buildPathRedactor(ecosystem, wslUbuntu, "/home/me/here");

describe("buildPathRedactor", () => {
  it("hides a repo's path in every notation this process may print", () => {
    for (const p of [
      "E:\\assets\\unity-ithappy",
      "e:\\Assets\\Unity-Ithappy\\.context\\skills",
      "E:/assets/unity-ithappy/x",
      "/mnt/e/assets/unity-ithappy/.context",
      "/mnt/wsl/Ubuntu-24.04/home/me/server/.context/contracts/users.md",
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\server",
      "/mnt/d/shared/contracts/users.md",
    ]) {
      const out = redact(`see ${p}.`);
      expect(out).not.toMatch(/unity-ithappy|home.me.server|shared.contracts/i);
      expect(out).toMatch(/<repo:(assets|server)>/);
    }
  });

  it("hides paths inside JSON (escaped backslashes)", () => {
    const json = JSON.stringify({ at: "E:\\assets\\unity-ithappy\\bin" });
    expect(JSON.parse(redact(json))).toEqual({ at: "<repo:assets>\\bin" });
  });

  it("only matches whole path segments", () => {
    expect(redact("E:\\assets\\unity-ithappy2")).toBe("E:\\assets\\unity-ithappy2");
  });

  it("leaves the current repo's own path alone", () => {
    expect(redact("/home/me/here/.context")).toBe("/home/me/here/.context");
  });
});
