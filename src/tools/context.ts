import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { z } from "zod";
import { cfg } from "../config.js";
import { invalidParams } from "../errors.js";
import { safeRead, listMdFiles, writeFileAtomic } from "../fsutil.js";
import { assertSafePath, parseAnyPath, toCanonicalPath, resolveStoredDir, type LocalPathResult } from "../paths.js";
import { readEcosystem, repoRoot } from "../ecosystem.js";
import { readManifest, writeManifest, currentRepoName, deepMerge } from "../manifest.js";
import { appendChangelog } from "../changelog.js";
import { extractSummary } from "../text.js";
import { logSkillChanges } from "../skills.js";
import { registrationNotice } from "../identity.js";
import type { ToolDef } from "../types.js";

function contextPath(root: string, domain: string, component?: string): string {
  const base = join(root, domain);
  return component ? join(base, `${component}.md`) : base;
}

const GetSchema = z.object({
  domain: z.string().min(1),
  component: z.string().optional(),
});

const UpdateSchema = z.object({
  domain: z.string().min(1),
  component: z.string().min(1),
  content: z.string().min(1),
});

const ListSchema = z.object({
  domain: z.string().optional(),
});

const GetFromSchema = z.object({
  repo: z.string().min(1),
  domain: z.string().min(1),
  component: z.string().optional(),
});

const ManifestUpdateSchema = z.object({
  patch: z.record(z.unknown()),
});

export const bridgeManifest: ToolDef = {
  name: "bridge_manifest",
  description:
    "Return the full manifest — registry of all domains, components, contracts, and ownership rules. Call this FIRST at the start of any session.",
  inputSchema: { type: "object", properties: {}, required: [] },
  async handler(_args, _ctx) {
    const manifest = await readManifest();
    const notice = await registrationNotice();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(manifest, null, 2),
          verbatim: true,
        },
        ...(notice ? [{ type: "text" as const, text: notice }] : []),
      ],
    };
  },
};

export const bridgeGet: ToolDef = {
  name: "bridge_get",
  description:
    "Fetch a context file from the current repo's .context/ folder. " +
    "Call bridge_manifest first to know which domains exist.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Domain folder name as declared in manifest.json",
      },
      component: {
        type: "string",
        description:
          "File name without .md extension. Omit to list the domain directory.",
      },
    },
    required: ["domain"],
  },
  async handler(args, _ctx) {
    const { domain, component } = GetSchema.parse(args);
    const path = contextPath(cfg().contextRoot, domain, component);
    assertSafePath(path, [cfg().contextRoot]);

    if (component) {
      const content = await safeRead(path);
      if (!content) {
        throw invalidParams(`No file found: .context/${domain}/${component}.md — use bridge_list to discover what exists`
        );
      }
      return { content: [{ type: "text", text: content, verbatim: true }] };
    }

    // No component — list the domain directory
    const keys = await listMdFiles(path);
    if (keys.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Domain .context/${domain} is empty or does not exist.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Files in .context/${domain}:\n${keys.map((k) => `  - ${k}`).join("\n")}`,
        },
      ],
    };
  },
};

export const bridgeUpdate: ToolDef = {
  name: "bridge_update",
  description:
    "Write or overwrite a context file. Call this after implementing a feature to keep .context/ in sync with the actual code.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string" },
      component: { type: "string", description: "File name without .md" },
      content: { type: "string", description: "Full markdown content" },
    },
    required: ["domain", "component", "content"],
  },
  async handler(args, _ctx) {
    const { domain, component, content } = UpdateSchema.parse(args);
    const path = contextPath(cfg().contextRoot, domain, component);
    assertSafePath(path, [cfg().contextRoot]);
    await mkdir(join(cfg().contextRoot, domain), { recursive: true });
    await writeFileAtomic(path, content);
    await appendChangelog({
      timestamp: new Date().toISOString(),
      repo: await currentRepoName(),
      type: "context",
      domain,
      component,
      summary: extractSummary(content),
    });
    return {
      content: [
        {
          type: "text",
          text: `✓ Written: .context/${domain}/${component}.md`,
        },
      ],
    };
  },
};

export const bridgeList: ToolDef = {
  name: "bridge_list",
  description:
    "List all available context files. Optionally filter by domain. Use for discovery when you don't know what files exist.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string" },
    },
    required: [],
  },
  async handler(args, _ctx) {
    const { domain } = ListSchema.parse(args ?? {});
    const base = domain ? join(cfg().contextRoot, domain) : cfg().contextRoot;
    assertSafePath(base, [cfg().contextRoot]);
    const keys = await listMdFiles(base);
    const prefix = domain ? `.context/${domain}/` : ".context/";

    return {
      content: [
        {
          type: "text",
          text:
            keys.length > 0
              ? keys.map((k) => `  - ${prefix}${k}`).join("\n")
              : "No context files found.",
        },
      ],
    };
  },
};

export const bridgeGetFrom: ToolDef = {
  name: "bridge_get_from",
  description:
    "Fetch a context file from another repo. " +
    "Pass a registered ecosystem repo name (from bridge_discover) or a relative path. " +
    "The other repo must have a .context/ folder.",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "Ecosystem repo name (e.g. 'my-api') or relative path (e.g. '../my-api')",
      },
      domain: {
        type: "string",
        description: "Domain folder name in that repo's .context/",
      },
      component: {
        type: "string",
        description:
          "File name without .md. Omit to list the domain directory.",
      },
    },
    required: ["repo", "domain"],
  },
  async handler(args, _ctx) {
    const { repo, domain, component } = GetFromSchema.parse(args);

    // Resolve repo name from ecosystem, or treat as relative/absolute path.
    // Absolute paths may use any notation (C:\..., \\wsl.localhost\..., /mnt/c/...).
    const ecosystem = await readEcosystem();
    const entry = ecosystem.repos[repo];
    const resolved: LocalPathResult = entry
      ? repoRoot(repo, entry)
      : parseAnyPath(repo)
        ? resolveStoredDir(toCanonicalPath(repo) ?? repo, `path "${repo}"`)
        : { path: resolve(cfg().cwd, repo) };
    if ("error" in resolved) {
      throw invalidParams(resolved.error);
    }
    const externalRoot = join(resolved.path, ".context");
    const path = contextPath(externalRoot, domain, component);
    assertSafePath(path, [externalRoot]);

    if (component) {
      const content = await safeRead(path);
      if (!content) {
        throw invalidParams(`No file found: ${repo}/.context/${domain}/${component}.md`
        );
      }
      return { content: [{ type: "text", text: content, verbatim: true }] };
    }

    const keys = await listMdFiles(path);
    return {
      content: [
        {
          type: "text",
          text:
            keys.length > 0
              ? keys.map((k) => `  - .context/${domain}/${k}`).join("\n")
              : `Domain .context/${domain} is empty or does not exist in ${repo}.`,
        },
      ],
    };
  },
};

export const bridgeManifestUpdate: ToolDef = {
  name: "bridge_manifest_update",
  description:
    "Deep-merge a patch object into manifest.json. Arrays are replaced wholesale, not appended — " +
    "read the current manifest first if you need to add to an existing array. " +
    "Use after registering a new domain, component, or contract.",
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "object",
        description:
          "Partial manifest object to deep-merge. Only provided keys are touched.",
      },
    },
    required: ["patch"],
  },
  async handler(args, _ctx) {
    const { patch } = ManifestUpdateSchema.parse(args);
    const current = await readManifest();
    const merged = deepMerge(current, patch);
    await writeManifest(merged);
    await appendChangelog({
      timestamp: new Date().toISOString(),
      repo: await currentRepoName(),
      type: "manifest",
      domain: "manifest",
      component: null,
      summary: "manifest updated",
    });
    await logSkillChanges(current, merged);
    return {
      content: [
        {
          type: "text",
          text: `✓ manifest.json updated.\n\n${JSON.stringify(merged, null, 2)}`,
        },
      ],
    };
  },
};
