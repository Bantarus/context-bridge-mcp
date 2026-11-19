import { rm } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { z } from "zod";
import { cfg, SKILLS_SOURCE, BRIDGE_SKILLS } from "../config.js";
import { invalidParams, internalError } from "../errors.js";
import { safeRead } from "../fsutil.js";
import { assertSafePath } from "../paths.js";
import { readEcosystem } from "../ecosystem.js";
import { readManifest, writeManifest, currentRepoName, deepMerge } from "../manifest.js";
import { appendChangelog, lastLoggedVersion } from "../changelog.js";
import { SKILL_NAME_RE, assertSkillName, consumerSkillsRoot, parseSkillFrontmatter, listPublishedSkills, providerContextRoot, emptyReport, copySkillDir, formatCopyReport, readInstalledSkills } from "../skills.js";
import type { ToolDef } from "../types.js";

const InstallSkillSchema = z.object({
  repo: z.string().min(1),
  skill: z.string().min(1),
  force: z.boolean().optional(),
});

const UninstallSkillSchema = z.object({
  skill: z.string().min(1),
});

const PublishSkillSchema = z.object({
  skill: z.string().min(1),
  version: z.string().min(1).optional(),
});

export const bridgeSyncSkills: ToolDef = {
  name: "bridge_sync_skills",
  description:
    "Install or update the companion Claude Code skills (context-reader, " +
    "context-feeder, context-bridge) into the current repo's .claude/skills/ folder, and refresh " +
    "every skill installed from other repos (manifest installedSkills) from its provider. " +
    "Run once when onboarding a repo, after updating the MCP server, or when bridge_changes reports skill drift.",
  inputSchema: { type: "object", properties: {}, required: [] },
  async handler(_args, _ctx) {
    const targetRoot = consumerSkillsRoot();

    if (!existsSync(SKILLS_SOURCE)) {
      throw internalError(`Skills source not found. Is the MCP server installed correctly?`
      );
    }

    const report = emptyReport();
    const notes: string[] = [];

    // 1. The bridge's own companion skills (never pruned: users may keep
    //    extra notes next to them)
    for (const skill of BRIDGE_SKILLS) {
      const src = join(SKILLS_SOURCE, skill);
      if (!existsSync(src)) continue;
      await copySkillDir(src, join(targetRoot, skill), skill, false, report);
    }

    // 2. Skills installed from other repos — the bridge owns these folders
    const installed = readInstalledSkills(await readManifest());
    const newVersions: Record<string, string | null> = {};
    if (Object.keys(installed).length > 0) {
      const ecosystem = await readEcosystem();
      for (const [skill, inst] of Object.entries(installed)) {
        if (!SKILL_NAME_RE.test(skill)) {
          notes.push(`⚠ skill "${skill}" skipped — invalid name in manifest installedSkills`);
          continue;
        }
        const provider = providerContextRoot(ecosystem, inst.from);
        if ("error" in provider) {
          notes.push(`⚠ skill "${skill}" not refreshed — ${provider.error}`);
          continue;
        }
        const published = (await listPublishedSkills(provider.path)).find((p) => p.name === skill);
        if (!published) {
          notes.push(
            `⚠ skill "${skill}": "${inst.from}" no longer publishes it — kept the local copy; bridge_uninstall_skill removes it`
          );
          continue;
        }
        await copySkillDir(published.dir, join(targetRoot, skill), skill, true, report);
        if (published.version !== inst.version) {
          newVersions[skill] = published.version;
          notes.push(
            `skill "${skill}" from ${inst.from}: v${inst.version ?? "?"} -> v${published.version ?? "?"}`
          );
        }
      }
    }
    if (Object.keys(newVersions).length > 0) {
      // Re-read so a concurrent manifest edit isn't lost
      const manifest = await readManifest();
      const current = readInstalledSkills(manifest);
      for (const [skill, version] of Object.entries(newVersions)) {
        if (current[skill]) current[skill] = { ...current[skill], version };
      }
      manifest.installedSkills = current;
      await writeManifest(manifest);
    }

    const lines = formatCopyReport(report);
    if (notes.length > 0) lines.push(notes.join("\n"));
    if (report.added.length + report.updated.length + report.removed.length === 0) {
      lines.push(`✓ All ${report.unchanged.length} skill files already up to date.`);
    } else {
      lines.push(`✓ Synced to .claude/skills/ (${report.unchanged.length} unchanged).`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
    };
  },
};

export const bridgeInstallSkill: ToolDef = {
  name: "bridge_install_skill",
  description:
    "Install a skill another ecosystem repo publishes (.context/skills/<skill>/ in that repo) into the " +
    "current repo's .claude/skills/<skill>/, and record it in manifest installedSkills so " +
    "bridge_sync_skills keeps it up to date. Files are copied as-is; nothing is executed. " +
    "Refuses to overwrite a skill folder the bridge did not install unless force is true. " +
    "Use bridge_discover to see which skills each repo publishes.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Provider repo name in the ecosystem" },
      skill: { type: "string", description: "Skill name (folder name under .context/skills/)" },
      force: {
        type: "boolean",
        description: "Overwrite an existing .claude/skills/<skill>/ the bridge did not install",
      },
    },
    required: ["repo", "skill"],
  },
  async handler(args, _ctx) {
    const { repo, skill, force } = InstallSkillSchema.parse(args);
    assertSkillName(skill);
    if (BRIDGE_SKILLS.includes(skill)) {
      throw invalidParams(`"${skill}" is one of the bridge's own skills — bridge_sync_skills installs it`
      );
    }
    const ecosystem = await readEcosystem();
    const provider = providerContextRoot(ecosystem, repo);
    if ("error" in provider) {
      throw invalidParams(`Cannot install from ${provider.error}`);
    }
    const publishedAll = await listPublishedSkills(provider.path);
    const published = publishedAll.find((p) => p.name === skill);
    if (!published) {
      const names = publishedAll.map((p) => p.name);
      throw invalidParams(`"${repo}" does not publish a skill named "${skill}".` +
          (names.length > 0 ? ` It publishes: ${names.join(", ")}.` : " It publishes no skills.")
      );
    }

    const targetRoot = consumerSkillsRoot();
    const dest = join(targetRoot, skill);
    assertSafePath(dest, [targetRoot]);
    const previous = readInstalledSkills(await readManifest())[skill];
    if (existsSync(dest) && !previous && !force) {
      throw invalidParams(`.claude/skills/${skill}/ already exists and was not installed by the bridge. ` +
          "Pass force: true to replace it with the provider's copy."
      );
    }

    const report = emptyReport();
    await copySkillDir(published.dir, dest, skill, true, report);

    const manifest = await readManifest();
    manifest.installedSkills = {
      ...readInstalledSkills(manifest),
      [skill]: { from: repo, version: published.version },
    };
    await writeManifest(manifest);

    const verb = previous ? "Reinstalled" : "Installed";
    const lines = [
      `✓ ${verb} skill "${skill}" ${published.version ? `v${published.version} ` : ""}from ${repo} into .claude/skills/${skill}/`,
      ...formatCopyReport(report),
    ];
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  },
};

export const bridgeUninstallSkill: ToolDef = {
  name: "bridge_uninstall_skill",
  description:
    "Remove a skill installed with bridge_install_skill: deletes .claude/skills/<skill>/ and its " +
    "manifest installedSkills entry. Refuses skills the bridge did not install.",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "Installed skill name" },
    },
    required: ["skill"],
  },
  async handler(args, _ctx) {
    const { skill } = UninstallSkillSchema.parse(args);
    assertSkillName(skill);
    const manifest = await readManifest();
    const installed = readInstalledSkills(manifest);
    if (!installed[skill]) {
      throw invalidParams(`Skill "${skill}" was not installed by the bridge (not in manifest installedSkills) — left untouched`
      );
    }
    const targetRoot = consumerSkillsRoot();
    const dest = join(targetRoot, skill);
    assertSafePath(dest, [targetRoot]);
    await rm(dest, { recursive: true, force: true });
    delete installed[skill];
    manifest.installedSkills = installed;
    await writeManifest(manifest);
    return {
      content: [
        { type: "text", text: `✓ Uninstalled skill "${skill}" (removed .claude/skills/${skill}/)` },
      ],
    };
  },
};

export const bridgePublishSkill: ToolDef = {
  name: "bridge_publish_skill",
  description:
    "Publish (or re-publish after a change) a skill this repo offers to other repos. The skill must " +
    "live at .context/skills/<skill>/SKILL.md. Records its version and description in manifest skills " +
    "and logs the version change to the changelog so consumers see it in bridge_changes. " +
    "The repo must expose \"skills\" in its ecosystem registration.",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "Skill folder name under .context/skills/" },
      version: {
        type: "string",
        description:
          "Version to publish. Defaults to metadata.version in the SKILL.md frontmatter; if both are set they must match.",
      },
    },
    required: ["skill"],
  },
  async handler(args, _ctx) {
    const { skill, version } = PublishSkillSchema.parse(args);
    assertSkillName(skill);
    const dir = join(cfg().contextRoot, "skills", skill);
    assertSafePath(dir, [cfg().contextRoot]);
    const skillMd = await safeRead(join(dir, "SKILL.md"));
    if (skillMd === null) {
      throw invalidParams(`No skill at .context/skills/${skill}/SKILL.md — create it there first`
      );
    }
    const front = parseSkillFrontmatter(skillMd);
    if (version && front.version && version !== front.version) {
      throw invalidParams(`version "${version}" does not match metadata.version "${front.version}" in SKILL.md — update one of them`
      );
    }
    const publishVersion = version ?? front.version;
    if (!publishVersion) {
      throw invalidParams("No version to publish — pass version, or set metadata.version in the SKILL.md frontmatter"
      );
    }

    const current = await readManifest();
    const existing = (current.skills as Record<string, { description?: unknown }> | undefined)?.[skill];
    const entry: Record<string, unknown> = { version: publishVersion };
    // Keep a hand-written manifest description; otherwise use the frontmatter's
    if (typeof existing?.description !== "string" && front.description) {
      entry.description = front.description;
    }
    const next = deepMerge(current, { skills: { [skill]: entry } });
    await writeManifest(next);

    // Compare with what was last *published* (the changelog), not the
    // manifest: a hand-edited manifest must not swallow a publish.
    const repoName = await currentRepoName();
    const published = await lastLoggedVersion(repoName, "skill", skill);
    const changed = published !== publishVersion;
    if (changed) {
      await appendChangelog({
        timestamp: new Date().toISOString(),
        repo: repoName,
        type: "skill",
        domain: skill,
        component: null,
        summary: published ? `${published} -> ${publishVersion}` : `published ${publishVersion}`,
        version: publishVersion,
      });
    }

    const warnings: string[] = [];
    const me = (await readEcosystem()).repos[repoName];
    if (!me) {
      warnings.push(`⚠ "${repoName}" is not registered in the ecosystem — run bridge_register so other repos can find it`);
    } else if (!me.exposes.includes("skills")) {
      warnings.push(`⚠ "${repoName}" does not expose "skills" — re-run bridge_register with "skills" in exposes`);
    }
    const head = changed
      ? `✓ Published skill "${skill}" v${publishVersion}`
      : `✓ Skill "${skill}" already published at v${publishVersion} — bump the version so consumers see changes`;
    return {
      content: [{ type: "text", text: [head, ...warnings].join("\n") }],
    };
  },
};
