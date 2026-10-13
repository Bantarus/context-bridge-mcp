import { describe, it, expect } from "vitest";
import { parseSkillFrontmatter } from "../../src/index.js";

describe("parseSkillFrontmatter", () => {
  it("reads a folded description and metadata.version", () => {
    const md = [
      "---",
      "name: asset-library",
      "description: >",
      "  Find 3D models",
      "  in the library.",
      "metadata:",
      "  version: 1.0.0",
      "  provider: world-builder-studio",
      "---",
      "# Body",
    ].join("\n");
    expect(parseSkillFrontmatter(md)).toEqual({
      description: "Find 3D models in the library.",
      version: "1.0.0",
    });
  });

  it("handles quoted scalars, CRLF and a top-level version", () => {
    const md = '---\r\nname: x\r\ndescription: "Does things: well"\r\nversion: \'2.1\'\r\n---\r\nbody';
    expect(parseSkillFrontmatter(md)).toEqual({ description: "Does things: well", version: "2.1" });
  });

  it("prefers metadata.version over a top-level version", () => {
    const md = "---\nversion: 1\nmetadata:\n  version: 3.0.0\n---\n";
    expect(parseSkillFrontmatter(md).version).toBe("3.0.0");
  });

  it("does not mistake nested keys for top-level ones", () => {
    const md = "---\nname: x\nmetadata:\n  description: nested\n---\n";
    expect(parseSkillFrontmatter(md)).toEqual({ description: null, version: null });
  });

  it("returns nulls without frontmatter", () => {
    expect(parseSkillFrontmatter("# Just a heading\nversion: 1")).toEqual({
      description: null,
      version: null,
    });
  });
});
