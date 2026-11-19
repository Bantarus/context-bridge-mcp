import { describe, it, expect } from "vitest";
import { watchMatchesEntry } from "../../src/changelog.js";
import {
  entryTopic,
  isValidPattern,
  parseTopic,
  subscriptionsOf,
  topicMatches,
  watchesToPatterns,
} from "../../src/bus/topics.js";
import type { ChangelogEntry } from "../../src/types.js";

const entry = (repo: string, type: ChangelogEntry["type"], domain: string): ChangelogEntry => ({
  timestamp: "2026-11-19T00:00:00Z",
  repo,
  type,
  domain,
  component: null,
  summary: "",
});

describe("topics", () => {
  it("matches * against exactly one segment", () => {
    expect(topicMatches("voicy/contracts/*", "voicy/contracts/users")).toBe(true);
    expect(topicMatches("*/skills/*", "facet/skills/palette")).toBe(true);
    expect(topicMatches("voicy/*", "voicy/contracts/users")).toBe(false);
    expect(topicMatches("voicy/releases", "voicy/releases")).toBe(true);
  });

  it("validates topics and patterns", () => {
    expect(parseTopic("voicy/releases")).toEqual({ owner: "voicy", name: "releases" });
    expect(parseTopic("voicy/*")).toBeNull();
    expect(parseTopic("voicy/a/b")).toBeNull();
    expect(isValidPattern("*/contracts/*")).toBe(true);
    expect(isValidPattern("voicy")).toBe(false);
    expect(isValidPattern("../x")).toBe(false);
  });

  it("reads watches exactly as the old watch filter did (minus messages)", () => {
    const lists = [["contracts"], ["users"], ["skills", "users"], ["manifest"], ["context"], ["CONTRACTS"], ["messages"]];
    const entries = [
      entry("voicy", "contract", "users"),
      entry("voicy", "contract", "orders"),
      entry("voicy", "context", "users"),
      entry("voicy", "skill", "users"),
      entry("voicy", "skill", "palette"),
      entry("voicy", "manifest", "manifest"),
      entry("other", "contract", "users"),
    ];
    for (const list of lists) {
      const patterns = watchesToPatterns({ voicy: list });
      for (const e of entries) {
        const topic = entryTopic(e)!;
        const old = e.repo === "voicy" && watchMatchesEntry(list, e);
        expect(patterns.some((p) => topicMatches(p, topic)), `${list} vs ${topic}`).toBe(old);
      }
    }
  });

  it("defaults to contract changes only when nothing is declared", () => {
    expect(subscriptionsOf({}).defaults).toEqual(["*/contracts/*"]);
    expect(subscriptionsOf({ watches: {} }).defaults).toEqual([]);
    expect(subscriptionsOf({ subscriptions: [] }).defaults).toEqual([]);
    const s = subscriptionsOf({ installedSkills: { palette: { from: "facet", version: "1" } } });
    expect(s.implicit).toEqual(["ecosystem/announce", "facet/skills/palette"]);
  });
});
