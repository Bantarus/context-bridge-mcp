import { describe, it, expect } from "vitest";
import { contractSummary, entryVersion, extractNewestChangelogLine } from "../../src/index.js";

const doc = (v: string) =>
  `# Contract: x\n\n## Version\n${v}\n\n## Changelog\n\n* 2026-11-19: newest\n- older\n\n## Other\n`;

describe("extractNewestChangelogLine", () => {
  it("returns the first bullet under ## Changelog", () => {
    expect(extractNewestChangelogLine(doc("1"))).toBe("2026-11-19: newest");
  });
  it("is null without a changelog or entries", () => {
    expect(extractNewestChangelogLine("# x\n## Version\n1\n")).toBeNull();
    expect(extractNewestChangelogLine("## Changelog\n\n## Next\n- x")).toBeNull();
  });
});

describe("contractSummary", () => {
  it("shows the version move and the newest line", () => {
    expect(contractSummary("1.9", doc("1.10"))).toEqual({
      summary: "1.9 -> 1.10: 2026-11-19: newest",
      version: "1.10",
    });
  });
  it("handles first publish and unchanged versions", () => {
    expect(contractSummary(null, doc("2")).summary).toBe("2: 2026-11-19: newest");
    expect(contractSummary("2", doc("2")).summary).toBe("2 (version unchanged): 2026-11-19: newest");
  });
  it("falls back to the title without a version", () => {
    expect(contractSummary(null, "# Contract: y\nbody")).toEqual({ summary: "Contract: y", version: null });
  });
});

describe("entryVersion", () => {
  const base = { timestamp: "t", repo: "r", domain: "d", component: null };
  it("prefers the version field, then parses legacy skill summaries", () => {
    expect(entryVersion({ ...base, type: "contract", summary: "x", version: "3" })).toBe("3");
    expect(entryVersion({ ...base, type: "skill", summary: "published 1.0.0" })).toBe("1.0.0");
    expect(entryVersion({ ...base, type: "skill", summary: "1.3.0 -> 1.4.0" })).toBe("1.4.0");
    expect(entryVersion({ ...base, type: "contract", summary: "Contract: vessel-cli" })).toBeNull();
  });
});
