import { join } from "path";
import { cfg } from "./config.js";
import { appendChangelog } from "./changelog.js";
import { updateEcosystem } from "./ecosystem.js";
import { currentRepoName } from "./manifest.js";
import { contractSummary, extractVersion } from "./text.js";

// ─── Contracts ───────────────────────────────────────────────────────────────

export function contractPath(domain: string): string {
  return join(cfg().contractsRoot, `${domain}.md`);
}

export async function logContractChange(
  domain: string,
  content: string,
  previous: string | null
): Promise<string> {
  const { summary, version } = contractSummary(previous, content);
  await appendChangelog({
    timestamp: new Date().toISOString(),
    repo: await currentRepoName(),
    type: "contract",
    domain,
    component: null,
    summary,
    ...(version ? { version } : {}),
  });
  return summary;
}

export async function trackConsumedVersion(
  domain: string,
  content: string,
  source: string
): Promise<void> {
  // Don't pin self-consumption — owning a contract isn't consuming it
  if (source === "local") return;

  const version = extractVersion(content);
  if (!version) {
    console.error(
      `[context-bridge] contract "${domain}" from ${source} has no parseable ## Version section — skipping pin`
    );
    return;
  }

  const repoName = await currentRepoName();
  await updateEcosystem((ecosystem) => {
    const entry = ecosystem.repos[repoName];
    if (!entry) return false;  // repo not registered, can't track

    // Only update consumedAt when the version (or source) actually changes —
    // makes the field mean "since when has this consumption been at this version"
    const existing = entry.consumedVersions?.[domain];
    if (existing && existing.version === version && existing.source === source) {
      return false;  // no change, no write
    }

    entry.consumedVersions ??= {};
    entry.consumedVersions[domain] = {
      version,
      source,
      consumedAt: new Date().toISOString(),
    };
  });
}
