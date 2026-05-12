import { describe, it, expect } from "vitest";
import { deepMerge } from "../../src/index.js";

describe("deepMerge", () => {
  it("merges flat objects", () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("source value overrides target value for same key", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("recursively merges nested objects", () => {
    const target = { domains: { api: { routes: "v1" } } };
    const source = { domains: { api: { schemas: "v1" } } };
    expect(deepMerge(target, source)).toEqual({
      domains: { api: { routes: "v1", schemas: "v1" } },
    });
  });

  it("replaces arrays wholesale (does not concatenate)", () => {
    const target = { tags: ["a", "b"] };
    const source = { tags: ["c"] };
    expect(deepMerge(target, source)).toEqual({ tags: ["c"] });
  });

  it("replaces array on target with object on source", () => {
    expect(deepMerge({ x: [1, 2] }, { x: { a: 1 } })).toEqual({ x: { a: 1 } });
  });

  it("replaces object on target with array on source", () => {
    expect(deepMerge({ x: { a: 1 } }, { x: [1, 2] })).toEqual({ x: [1, 2] });
  });

  it("treats null in source as a value (replaces target)", () => {
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null });
  });

  it("does not mutate the target object", () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    deepMerge(target, source);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("empty source returns shallow copy of target", () => {
    const target = { a: 1 };
    const result = deepMerge(target, {});
    expect(result).toEqual({ a: 1 });
    expect(result).not.toBe(target);
  });

  it("primitive on target gets replaced by object on source", () => {
    expect(deepMerge({ a: 1 }, { a: { nested: true } })).toEqual({
      a: { nested: true },
    });
  });
});
