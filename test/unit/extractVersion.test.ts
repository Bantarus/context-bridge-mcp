import { describe, it, expect } from "vitest";
import { extractVersion } from "../../src/index.js";

describe("extractVersion", () => {
  describe("inline form (## Version: <value>)", () => {
    it("parses '## Version: 2.1'", () => {
      expect(extractVersion("## Version: 2.1")).toBe("2.1");
    });

    it("is case-insensitive", () => {
      expect(extractVersion("## version: 2.1")).toBe("2.1");
      expect(extractVersion("## VERSION: 2.1")).toBe("2.1");
    });

    it("strips leading 'v' prefix", () => {
      expect(extractVersion("## Version: v2.1")).toBe("2.1");
      expect(extractVersion("## Version: V3.0.0")).toBe("3.0.0");
    });

    it("handles full-width colon", () => {
      expect(extractVersion("## Version：2.1")).toBe("2.1");
    });

    it("trims whitespace around the value", () => {
      expect(extractVersion("## Version:   2.1   ")).toBe("2.1");
    });
  });

  describe("standalone heading form (## Version on its own line)", () => {
    it("reads value from the next non-empty line", () => {
      expect(extractVersion("## Version\n2.1")).toBe("2.1");
    });

    it("skips blank lines between heading and value", () => {
      expect(extractVersion("## Version\n\n\n2.1")).toBe("2.1");
    });

    it("strips leading 'v' prefix from next-line value", () => {
      expect(extractVersion("## Version\nv2.1")).toBe("2.1");
    });

    it("returns null if the next non-empty line is another heading", () => {
      expect(extractVersion("## Version\n## Changelog\n2.1")).toBeNull();
    });

    it("returns null if no value follows the heading", () => {
      expect(extractVersion("## Version\n")).toBeNull();
    });
  });

  describe("absent / malformed", () => {
    it("returns null when there is no Version section", () => {
      expect(extractVersion("# Title\n\nSome body")).toBeNull();
    });

    it("returns null for empty content", () => {
      expect(extractVersion("")).toBeNull();
    });

    it("returns null for '## Version 2.1' (missing colon, strict)", () => {
      // The parser requires either a colon on the heading line or the value
      // on the next non-empty line. A trailing value on the heading without
      // a colon does not match either rule.
      expect(extractVersion("## Version 2.1")).toBeNull();
    });
  });

  describe("within a larger document", () => {
    it("finds version among other headings", () => {
      const doc = `# Contract: users

## Purpose
Users API contract

## Version
2.1

## Changelog
- 2026-04-21: bumped`;
      expect(extractVersion(doc)).toBe("2.1");
    });

    it("finds the FIRST version section if duplicated", () => {
      const doc = `## Version: 1.0\n\n## Version: 2.0`;
      expect(extractVersion(doc)).toBe("1.0");
    });
  });
});
