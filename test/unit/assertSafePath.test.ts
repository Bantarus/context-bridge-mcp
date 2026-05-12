import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { assertSafePath } from "../../src/index.js";

describe("assertSafePath", () => {
  const root = resolve("/tmp/bridge-test-root");
  const otherRoot = resolve("/tmp/bridge-test-other");

  it("allows a path that is a direct child of the root", () => {
    expect(() =>
      assertSafePath(resolve(root, "file.md"), [root])
    ).not.toThrow();
  });

  it("allows a deeply nested path inside the root", () => {
    expect(() =>
      assertSafePath(resolve(root, "a/b/c/file.md"), [root])
    ).not.toThrow();
  });

  it("allows a path equal to the root", () => {
    expect(() => assertSafePath(root, [root])).not.toThrow();
  });

  it("rejects a path outside the root (sibling)", () => {
    expect(() =>
      assertSafePath(resolve("/tmp/bridge-test-other/file.md"), [root])
    ).toThrow(/escapes allowed roots/i);
  });

  it("rejects a path that is the parent of the root", () => {
    expect(() => assertSafePath(resolve("/tmp"), [root])).toThrow(
      /escapes allowed roots/i
    );
  });

  it("rejects when the resolved path starts with the root name but is a sibling", () => {
    // /tmp/bridge-test-root-evil is not inside /tmp/bridge-test-root
    expect(() =>
      assertSafePath(resolve("/tmp/bridge-test-root-evil/x"), [root])
    ).toThrow(/escapes allowed roots/i);
  });

  it("allows when path is inside any one of multiple allowed roots", () => {
    expect(() =>
      assertSafePath(resolve(otherRoot, "file.md"), [root, otherRoot])
    ).not.toThrow();
  });

  it("rejects when path is outside all of multiple allowed roots", () => {
    expect(() =>
      assertSafePath(resolve("/tmp/somewhere-else/x"), [root, otherRoot])
    ).toThrow(/escapes allowed roots/i);
  });

  it("rejects when allowed roots is empty", () => {
    expect(() => assertSafePath(resolve("/tmp/anything"), [])).toThrow(
      /escapes allowed roots/i
    );
  });
});
