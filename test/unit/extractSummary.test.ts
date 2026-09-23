import { describe, it, expect } from "vitest";
import { extractSummary } from "../../src/index.js";

describe("extractSummary", () => {
  it("returns the first non-empty line", () => {
    expect(extractSummary("hello world")).toBe("hello world");
  });

  it("skips leading blank lines", () => {
    expect(extractSummary("\n\n  \nactual content")).toBe("actual content");
  });

  it("strips a single leading '#' and following whitespace", () => {
    expect(extractSummary("# Title")).toBe("Title");
  });

  it("strips multiple leading '#'", () => {
    expect(extractSummary("### Sub heading")).toBe("Sub heading");
  });

  it("does not strip '#' that appears mid-line", () => {
    expect(extractSummary("Use # for headings")).toBe("Use # for headings");
  });

  it("returns an empty string for empty content", () => {
    expect(extractSummary("")).toBe("");
  });

  it("returns an empty string for whitespace-only content", () => {
    expect(extractSummary("   \n\n\t\n")).toBe("");
  });

  it("truncates at 80 characters", () => {
    const long = "x".repeat(120);
    expect(extractSummary(long)).toBe("x".repeat(80));
  });

  it("ignores content after the first non-empty line", () => {
    expect(extractSummary("first line\nsecond line\nthird line")).toBe(
      "first line"
    );
  });

  it("drops the carriage return from CRLF content", () => {
    expect(extractSummary("# Title\r\nbody\r\n")).toBe("Title");
  });
});
