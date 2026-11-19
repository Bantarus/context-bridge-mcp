import { objectField, stringArrayField } from "../manifest.js";
import { WATCH_CATEGORY_ALIASES } from "../changelog.js";
import type { ChangelogEntry, Manifest } from "../types.js";

// ─── Topics and subscriptions (pure) ─────────────────────────────────────────
//
// A topic is `<owner>/<name>`. Automatic topics mirror the changes the bridge
// already logs (`<repo>/contracts/<domain>`, `<repo>/skills/<name>`,
// `<repo>/context/<domain>`, `<repo>/manifest`); declared topics are listed
// by their owner in manifest `topics` and carry posted messages. A pattern is
// a topic in which `*` matches exactly one segment.

export const ANNOUNCE_TOPIC = "ecosystem/announce";
/** Second segments reserved for automatic topics: nobody posts to them by hand. */
export const AUTOMATIC_KINDS = ["contracts", "skills", "context", "manifest"];
export const POST_RULES = ["owner", "subscribers", "any"] as const;
export type PostRule = (typeof POST_RULES)[number];

export interface TopicDecl {
  description?: string;
  post: PostRule;
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidPattern(p: string): boolean {
  const segs = p.split("/");
  return segs.length >= 2 && segs.every((s) => s === "*" || SEGMENT_RE.test(s));
}

/** A postable topic: exactly `<owner>/<name>`, no wildcards. */
export function parseTopic(t: string): { owner: string; name: string } | null {
  const segs = t.split("/");
  if (segs.length !== 2 || !segs.every((s) => SEGMENT_RE.test(s))) return null;
  return { owner: segs[0], name: segs[1] };
}

export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.split("/");
  const t = topic.split("/");
  return p.length === t.length && p.every((s, i) => s === "*" || s === t[i]);
}

/** The automatic topic a changelog entry belongs to, or null for legacy messages. */
export function entryTopic(e: ChangelogEntry): string | null {
  switch (e.type) {
    case "contract":
      return `${e.repo}/contracts/${e.domain}`;
    case "skill":
      return `${e.repo}/skills/${e.domain}`;
    case "context":
      return `${e.repo}/context/${e.domain}`;
    case "manifest":
      return `${e.repo}/manifest`;
    default:
      return null;
  }
}

/**
 * `watches` read as subscriptions: a category keyword watches that category,
 * any other token watches that domain in every category (the same entries
 * `watchMatchesEntry` matches). Watching messages is dropped: other repos'
 * direct messages are not a feed.
 */
export function watchesToPatterns(watches: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [repo, list] of Object.entries(watches)) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const alias = WATCH_CATEGORY_ALIASES[raw.toLowerCase()];
      if (alias === "message") continue;
      if (alias === "manifest") out.push(`${repo}/manifest`);
      else if (alias) out.push(`${repo}/${alias === "context" ? "context" : `${alias}s`}/*`);
      else out.push(`${repo}/*/${raw}`);
    }
  }
  return out;
}

export interface Subscriptions {
  /** Listed in manifest `subscriptions`. */
  explicit: string[];
  /** Derived from manifest `watches`. */
  fromWatches: string[];
  /** Applied when neither is declared. */
  defaults: string[];
  /** Always on: installed skills' topics and the ecosystem announcements. */
  implicit: string[];
  /** The union actually matched against. */
  effective: string[];
}

export function subscriptionsOf(manifest: Manifest): Subscriptions {
  const explicit = stringArrayField(manifest, "subscriptions");
  const watchesDeclared = manifest.watches !== undefined;
  const fromWatches = watchesToPatterns(objectField(manifest, "watches"));
  // No watches, no subscriptions: every contract change, as before
  const defaults =
    !watchesDeclared && !("subscriptions" in manifest) ? ["*/contracts/*"] : [];
  const implicit = [
    ANNOUNCE_TOPIC,
    ...Object.entries(objectField<{ from?: unknown }>(manifest, "installedSkills"))
      .filter(([, v]) => typeof v?.from === "string")
      .map(([skill, v]) => `${v.from}/skills/${skill}`),
  ];
  const effective = [...new Set([...explicit, ...fromWatches, ...defaults, ...implicit])];
  return { explicit, fromWatches, defaults, implicit, effective };
}

export function isSubscribed(subs: Subscriptions, topic: string): boolean {
  return subs.effective.some((p) => topicMatches(p, topic));
}

/** Topics a repo declares in its manifest, with defaults filled in. */
export function declaredTopics(manifest: Manifest): Record<string, TopicDecl> {
  const out: Record<string, TopicDecl> = {};
  for (const [name, raw] of Object.entries(objectField<Record<string, unknown>>(manifest, "topics"))) {
    if (!SEGMENT_RE.test(name) || AUTOMATIC_KINDS.includes(name)) continue;
    const post = POST_RULES.includes(raw?.post as PostRule) ? (raw.post as PostRule) : "owner";
    out[name] = {
      post,
      ...(typeof raw?.description === "string" ? { description: raw.description } : {}),
    };
  }
  return out;
}
