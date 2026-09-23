import { describe, it, expect } from "vitest";
import {
  parseAnyPath,
  toCanonicalPath,
  toLocalPath,
  type PathEnv,
} from "../../src/index.js";

const wslUbuntu: PathEnv = {
  platform: "linux",
  wslDistro: "Ubuntu",
  wslDrivesRoot: "/mnt",
  wslDistrosRoot: "/mnt/wsl",
};
const wslOther: PathEnv = { ...wslUbuntu, wslDistro: "Ubuntu-24.04" };
const windows: PathEnv = {
  platform: "win32",
  wslDrivesRoot: "/mnt",
  wslDistrosRoot: "/mnt/wsl",
};
const plainLinux: PathEnv = {
  platform: "linux",
  wslDrivesRoot: "/mnt",
  wslDistrosRoot: "/mnt/wsl",
};

describe("parseAnyPath", () => {
  it("returns null for relative paths", () => {
    expect(parseAnyPath("../repo")).toBeNull();
    expect(parseAnyPath("repo")).toBeNull();
  });

  it("parses drive paths with either slash and normalizes dot segments", () => {
    expect(parseAnyPath("c:/Users/me/./x/../repo")).toEqual({
      kind: "drive",
      drive: "C",
      segs: ["Users", "me", "repo"],
    });
  });

  it("parses both \\\\wsl$ and \\\\wsl.localhost UNC forms", () => {
    const expected = { kind: "wsl", distro: "Ubuntu", segs: ["home", "me"] };
    expect(parseAnyPath("\\\\wsl$\\Ubuntu\\home\\me")).toEqual(expected);
    expect(parseAnyPath("\\\\wsl.localhost\\Ubuntu\\home\\me")).toEqual(expected);
    expect(parseAnyPath("//wsl.localhost/Ubuntu/home/me")).toEqual(expected);
  });
});

describe("toCanonicalPath", () => {
  it("returns null for relative paths", () => {
    expect(toCanonicalPath("./repo", wslUbuntu)).toBeNull();
  });

  it("maps a WSL-native path to the distro's UNC path", () => {
    expect(toCanonicalPath("/home/me/api", wslUbuntu)).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\api"
    );
  });

  it("maps /mnt/<drive> to a Windows drive path", () => {
    expect(toCanonicalPath("/mnt/c/Users/me/Client", wslUbuntu)).toBe(
      "C:\\Users\\me\\Client"
    );
  });

  it("maps a bind-mounted foreign distro to its UNC path", () => {
    expect(toCanonicalPath("/mnt/wsl/Ubuntu-24.04/home/me/svc", wslUbuntu)).toBe(
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\svc"
    );
  });

  it("accepts Windows-notation input from inside WSL", () => {
    expect(toCanonicalPath("C:\\Users\\me\\Client", wslUbuntu)).toBe(
      "C:\\Users\\me\\Client"
    );
    expect(toCanonicalPath("\\\\wsl$\\Ubuntu-24.04\\srv", wslUbuntu)).toBe(
      "\\\\wsl.localhost\\Ubuntu-24.04\\srv"
    );
  });

  it("normalizes \\\\wsl$ to \\\\wsl.localhost on Windows", () => {
    expect(toCanonicalPath("\\\\wsl$\\Ubuntu\\home\\me", windows)).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\me"
    );
  });

  it("keeps POSIX paths as-is outside WSL", () => {
    expect(toCanonicalPath("/home/me/api", plainLinux)).toBe("/home/me/api");
  });

  it("honors a custom drives root", () => {
    expect(
      toCanonicalPath("/c/work/app", { ...wslUbuntu, wslDrivesRoot: "/" })
    ).toBe("C:\\work\\app");
  });
});

describe("toLocalPath", () => {
  const ubuntuRepo = "\\\\wsl.localhost\\Ubuntu\\home\\me\\api";
  const otherRepo = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\svc";
  const winRepo = "C:\\Users\\me\\Client";

  it("round-trips through canonical form in the same distro", () => {
    expect(toLocalPath(ubuntuRepo, wslUbuntu)).toEqual({ path: "/home/me/api" });
  });

  it("matches the distro name case-insensitively", () => {
    expect(toLocalPath("\\\\wsl.localhost\\ubuntu\\x", wslUbuntu)).toEqual({ path: "/x" });
  });

  it("sends another distro's path through the bind-mount root", () => {
    expect(toLocalPath(ubuntuRepo, wslOther)).toEqual({
      path: "/mnt/wsl/Ubuntu/home/me/api",
    });
  });

  it("maps drive paths under the drives root from WSL", () => {
    expect(toLocalPath(winRepo, wslOther)).toEqual({ path: "/mnt/c/Users/me/Client" });
  });

  it("uses Windows-notation paths unchanged on Windows", () => {
    expect(toLocalPath(winRepo, windows)).toEqual({ path: winRepo });
    expect(toLocalPath(ubuntuRepo, windows)).toEqual({ path: ubuntuRepo });
  });

  it("translates legacy /mnt/<drive> entries on Windows", () => {
    expect(toLocalPath("/mnt/c/Users/me/Client", windows)).toEqual({ path: winRepo });
  });

  it("explains legacy WSL-native entries it cannot place on Windows", () => {
    const r = toLocalPath("/home/me/api", windows);
    expect("error" in r && r.error).toMatch(/re-run bridge_register/i);
  });

  it("keeps legacy POSIX entries working inside WSL", () => {
    expect(toLocalPath("/home/me/api", wslUbuntu)).toEqual({ path: "/home/me/api" });
  });

  it("reports Windows paths as unreachable outside WSL", () => {
    expect("error" in toLocalPath(winRepo, plainLinux)).toBe(true);
  });
});
