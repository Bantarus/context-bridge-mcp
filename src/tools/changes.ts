import { z } from "zod";
import { readEcosystem, updateEcosystem, readRepoContract } from "../ecosystem.js";
import { readManifest, currentRepoName } from "../manifest.js";
import { readChangelog, type ChangelogLine } from "../changelog.js";
import { openBus } from "../bus/core.js";
import { entryTopic, isSubscribed, subscriptionsOf } from "../bus/topics.js";
import type { InboxItem } from "../bus/state.js";
import { extractVersion } from "../text.js";
import { listPublishedSkills, providerContextRoot, readInstalledSkills } from "../skills.js";
import type { ToolDef } from "../types.js";

/** Open inbox items, or none when this repo can't use the bus (not registered). */
async function openMessages(): Promise<InboxItem[]> {
  try {
    return await (await openBus("tool")).openItems();
  } catch {
    return [];
  }
}

const ChangesSchema = z.object({
  since: z.string().optional(),
});

export const bridgeChanges: ToolDef = {
  name: "bridge_changes",
  description:
    "Show changes from other repos and detect contract and skill version drift. " +
    "Compares consumed contract versions (pinned by bridge_get_contract) and installed skill versions " +
    "(recorded by bridge_install_skill) against what the providers publish now. " +
    "Also shows changelog entries filtered by 'watches' in manifest.json (or all contract changes, plus " +
    "updates to installed skills, if no watches). " +
    "Call at session start after bridge_manifest and bridge_discover.",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description:
          "ISO date to look back from (e.g. '2026-04-15'). " +
          "Omit to use this repo's last-checked cursor from the ecosystem.",
      },
    },
    required: [],
  },
  async handler(args, _ctx) {
    const { since } = ChangesSchema.parse(args ?? {});
    const repoName = await currentRepoName();
    const manifest = await readManifest();
    const installedSkills = readInstalledSkills(manifest);
    const ecosystem = await readEcosystem();
    const myEntry = ecosystem.repos[repoName];

    // ── Part 1: changelog entries since cursor ──
    // Default cursor is a line position, immune to clock skew between the
    // Windows host and WSL2 VMs. An explicit `since`, or a repo that has
    // never checked (or a truncated changelog), falls back to timestamps.
    const { entries: allEntries, lineCount } = await readChangelog();
    const lineCursor =
      !since &&
      myEntry?.changelogCursor !== undefined &&
      myEntry.changelogCursor <= lineCount
        ? myEntry.changelogCursor
        : undefined;
    const cursor = since ?? myEntry?.lastCheckedAt ?? "1970-01-01T00:00:00Z";

    const isNew = (e: ChangelogLine) =>
      lineCursor !== undefined ? e.line >= lineCursor : e.timestamp > cursor;

    // Messages live on the bus; they stay listed until acknowledged
    const inboxLines = (await openMessages()).map(
      (i) => `  [${i.id}] ${i.priority === "high" ? "high  " : ""}${i.intent} from ${i.from}: "${i.subject}"`
    );

    // Changes are matched as topics against subscriptions (watches count)
    const subs = subscriptionsOf(manifest);
    const relevant = allEntries.filter((e) => {
      if (e.repo === repoName) return false;
      if (!isNew(e)) return false;
      const topic = entryTopic(e);
      return topic !== null && isSubscribed(subs, topic);
    });

    const changeLines = relevant.map((e) => {
      const date = e.timestamp.slice(0, 10);
      const target = e.component
        ? `${e.domain}/${e.component}`
        : e.domain;
      let line = `  [${date}] ${e.repo} updated ${e.type} "${target}"`;
      if (e.summary) line += `\n    → ${e.summary}`;
      return line;
    });

    // ── Part 2: version drift detection ──
    const driftLines: string[] = [];
    const consumed = myEntry?.consumedVersions ?? {};

    for (const [contractDomain, pin] of Object.entries(consumed)) {
      const sourceEntry = ecosystem.repos[pin.source];
      // Source repo no longer in ecosystem — surface as orphan dependency
      if (!sourceEntry) {
        driftLines.push(
          `  ⚠ contract "${contractDomain}": pinned to v${pin.version} from "${pin.source}", but "${pin.source}" is no longer registered in the ecosystem`
        );
        continue;
      }

      const result = await readRepoContract(pin.source, sourceEntry, contractDomain);
      if ("error" in result) {
        driftLines.push(
          `  ⚠ contract "${contractDomain}": pinned to v${pin.version}, but drift cannot be checked — ${result.error}`
        );
        continue;
      }
      const currentContent = result.content;

      if (!currentContent) {
        driftLines.push(
          `  ⚠ contract "${contractDomain}": pinned to v${pin.version} from "${pin.source}", but the contract file no longer exists in that repo`
        );
        continue;
      }

      const currentVersion = extractVersion(currentContent);
      if (!currentVersion) continue;
      if (currentVersion !== pin.version) {
        driftLines.push(
          `  ⚠ contract "${contractDomain}": you consumed v${pin.version} from ${pin.source} on ${pin.consumedAt.slice(0, 10)}, current is v${currentVersion}`
        );
      }
    }

    // Installed skills vs. what their providers publish now
    for (const [skill, inst] of Object.entries(installedSkills)) {
      const provider = providerContextRoot(ecosystem, inst.from);
      if ("error" in provider) {
        driftLines.push(
          `  ⚠ skill "${skill}": installed v${inst.version ?? "?"} from "${inst.from}", but drift cannot be checked — ${provider.error}`
        );
        continue;
      }
      const published = (await listPublishedSkills(provider.path)).find((p) => p.name === skill);
      if (!published) {
        driftLines.push(
          `  ⚠ skill "${skill}": installed v${inst.version ?? "?"} from "${inst.from}", but "${inst.from}" no longer publishes it — bridge_uninstall_skill removes the local copy`
        );
      } else if (published.version !== inst.version) {
        driftLines.push(
          `  ⚠ skill "${skill}": installed v${inst.version ?? "?"} from ${inst.from}, provider now publishes v${published.version ?? "?"} — run bridge_sync_skills to update`
        );
      }
    }

    // ── Update cursors — re-read under lock, touch only our own entry ──
    if (myEntry) {
      await updateEcosystem((eco) => {
        const entry = eco.repos[repoName];
        if (!entry) return false;
        entry.lastCheckedAt = new Date().toISOString();
        entry.changelogCursor = lineCount;
      });
    }

    // ── Build response ──
    const sections: string[] = [];

    if (inboxLines.length > 0) {
      sections.push(
        `Messages for you (${inboxLines.length} open) — read them with bridge_inbox:\n\n${inboxLines.join("\n")}`
      );
    }

    if (driftLines.length > 0) {
      sections.push(
        `Version drift detected (${driftLines.length}):\n\n${driftLines.join("\n\n")}`
      );
    }

    if (changeLines.length > 0) {
      sections.push(
        `${changeLines.length} change(s) since ${cursor.slice(0, 10)}:\n\n${changeLines.join("\n\n")}`
      );
    }

    if (sections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No changes or version drift since ${cursor.slice(0, 10)}.`,
          },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: sections.join("\n\n---\n\n") },
      ],
    };
  },
};
