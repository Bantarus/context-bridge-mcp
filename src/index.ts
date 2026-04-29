import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readFile, writeFile, appendFile, readdir, mkdir, rename } from "fs/promises";
import { join, resolve, relative, isAbsolute } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONTEXT_ROOT = resolve(
  process.env.CONTEXT_ROOT ?? join(process.cwd(), ".context")
);

const CONTRACTS_ROOT = resolve(
  process.env.CONTRACTS_ROOT ?? join(CONTEXT_ROOT, "contracts")
);

const MANIFEST_PATH = join(CONTEXT_ROOT, "manifest.json");

const ECOSYSTEM_ROOT = resolve(
  process.env.ECOSYSTEM_ROOT ?? join(homedir(), ".context-bridge")
);

const ECOSYSTEM_PATH = join(ECOSYSTEM_ROOT, "ecosystem.json");

const CHANGELOG_PATH = join(ECOSYSTEM_ROOT, "changelog.jsonl");

// Skills shipped with this MCP server (relative to compiled dist/index.js)
const SKILLS_SOURCE = resolve(import.meta.dirname, "..", ".claude", "skills");
const BRIDGE_SKILLS = ["context-reader", "context-feeder", "context-bridge"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConsumedVersion {
  version: string;
  source: string;       // which repo the contract was read from
  consumedAt: string;   // ISO timestamp of when it was read
}

interface EcosystemEntry {
  path: string;
  exposes: string[];
  stack?: string;
  registeredAt: string;
  lastCheckedAt?: string;
  consumedVersions?: Record<string, ConsumedVersion>;  // keyed by contract domain
}

interface Ecosystem {
  version: string;
  repos: Record<string, EcosystemEntry>;
}

interface ChangelogEntry {
  timestamp: string;
  repo: string;
  type: "context" | "contract" | "manifest";
  domain: string;
  component: string | null;
  summary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readEcosystem(): Promise<Ecosystem> {
  try {
    const raw = await readFile(ECOSYSTEM_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: "1.0", repos: {} };
  }
}

async function writeEcosystem(data: Ecosystem): Promise<void> {
  await mkdir(ECOSYSTEM_ROOT, { recursive: true });
  await writeFileAtomic(ECOSYSTEM_PATH, JSON.stringify(data, null, 2));
}

async function readManifest(): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, "utf-8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      "manifest.json is malformed — fix or delete the file to re-initialize"
    );
  }
}

async function writeManifest(data: Record<string, unknown>): Promise<void> {
  await writeFileAtomic(MANIFEST_PATH, JSON.stringify(data, null, 2));
}

function contextPath(
  root: string,
  domain: string,
  component?: string
): string {
  const base = join(root, domain);
  return component ? join(base, `${component}.md`) : base;
}

function contractPath(domain: string): string {
  return join(CONTRACTS_ROOT, `${domain}.md`);
}

async function writeFileAtomic(target: string, data: string): Promise<void> {
  // Write to a sibling temp file then rename — rename is atomic so readers
  // never see a torn file, and a crash mid-write leaves the original intact.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, target);
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) {
        results.push(e.name.replace(/\.md$/, ""));
      } else if (e.isDirectory()) {
        const nested = await listMdFiles(join(dir, e.name));
        results.push(...nested.map((n) => `${e.name}/${n}`));
      }
    }
    return results;
  } catch {
    return [];
  }
}

function assertSafePath(resolvedPath: string, allowedRoots: string[]): void {
  const safe = allowedRoots.some((root) => {
    const rel = relative(root, resolvedPath);
    return !rel.startsWith("..");
  });
  if (!safe) {
    throw new McpError(ErrorCode.InvalidParams, "Path escapes allowed roots");
  }
}

// ─── Changelog helpers ────────────────────────────────────────────────────────

function extractVersion(content: string): string | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match: ## Version, ## version, ## Version: 2.1, etc.
    const inline = line.match(/^##\s+version\s*[:：]\s*(.+)$/i);
    if (inline) {
      return inline[1].trim().replace(/^[v]/i, "");
    }
    // Match: ## Version (value on a following line)
    if (/^##\s+version\s*$/i.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const val = lines[j].trim();
        if (val.length === 0) continue;
        if (val.startsWith("#")) break;  // hit next section without a value
        return val.replace(/^[v]/i, "");
      }
    }
  }
  return null;
}

async function trackConsumedVersion(
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
  const ecosystem = await readEcosystem();
  const entry = ecosystem.repos[repoName];
  if (!entry) return;  // repo not registered, can't track

  if (!entry.consumedVersions) {
    entry.consumedVersions = {};
  }

  // Only update consumedAt when the version (or source) actually changes —
  // makes the field mean "since when has this consumption been at this version"
  const existing = entry.consumedVersions[domain];
  if (existing && existing.version === version && existing.source === source) {
    return;  // no change, no write
  }

  entry.consumedVersions[domain] = {
    version,
    source,
    consumedAt: new Date().toISOString(),
  };
  await writeEcosystem(ecosystem);
}

function extractSummary(content: string): string {
  const line = content.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").replace(/^#+\s*/, "").slice(0, 80);
}

async function currentRepoName(): Promise<string> {
  const manifest = await readManifest();
  if (typeof manifest.project === "string" && manifest.project) {
    return manifest.project;
  }
  // Fallback: directory name of CWD
  return process.cwd().split(/[\\/]/).pop() ?? "unknown";
}

async function appendChangelog(entry: ChangelogEntry): Promise<void> {
  await mkdir(ECOSYSTEM_ROOT, { recursive: true });
  await appendFile(CHANGELOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

async function readChangelog(): Promise<ChangelogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(CHANGELOG_PATH, "utf-8");
  } catch {
    return [];
  }
  const entries: ChangelogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ─── Tool schemas ─────────────────────────────────────────────────────────────

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

const ContractGetSchema = z.object({
  domain: z.string().min(1),
});

const ContractUpdateSchema = z.object({
  domain: z.string().min(1),
  content: z.string().min(1),
});

const ManifestUpdateSchema = z.object({
  patch: z.record(z.unknown()),
});

const RegisterSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  exposes: z.array(z.string()).min(1),
  stack: z.string().optional(),
});

const DiscoverSchema = z.object({
  name: z.string().optional(),
});

const ChangesSchema = z.object({
  since: z.string().optional(),
});

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "context-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── List tools ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bridge_manifest",
      description:
        "Return the full manifest — registry of all domains, components, contracts, and ownership rules. Call this FIRST at the start of any session.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
      name: "bridge_get_contract",
      description:
        "Fetch the API contract for a domain. Searches: 1) current repo's contracts, " +
        "2) all ecosystem repos that expose 'contracts'. No need to know which repo owns it. " +
        "Automatically pins the consumed version — bridge_changes will detect drift if the contract is updated later.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Contract domain name" },
        },
        required: ["domain"],
      },
    },
    {
      name: "bridge_update_contract",
      description:
        "Write or overwrite an API contract file. Use when adding a new endpoint, event shape, or shared type.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          content: { type: "string", description: "Full markdown content" },
        },
        required: ["domain", "content"],
      },
    },
    {
      name: "bridge_list_contracts",
      description: "List all existing contract files.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "bridge_register",
      description:
        "Register a repo in the shared ecosystem. Call once per repo to declare " +
        "its existence, path, and which domains it exposes publicly. " +
        "Other repos can then discover it via bridge_discover.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Unique repo name (e.g. 'game-backend', 'billing-api')",
          },
          path: {
            type: "string",
            description: "Absolute path to the repo root",
          },
          exposes: {
            type: "array",
            items: { type: "string" },
            description:
              "Domain names this repo exposes publicly (e.g. ['services', 'contracts'])",
          },
          stack: {
            type: "string",
            description: "Tech stack description (e.g. 'Node.js / Nakama')",
          },
        },
        required: ["name", "path", "exposes"],
      },
    },
    {
      name: "bridge_discover",
      description:
        "Discover repos registered in the ecosystem. Call with no args to list " +
        "all repos and their exposed domains. Pass a name to get details " +
        "including its manifest. Use the repo name with bridge_get_from to read its files.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Repo name to inspect. Omit to list all repos.",
          },
        },
        required: [],
      },
    },
    {
      name: "bridge_changes",
      description:
        "Show changes from other repos and detect contract version drift. " +
        "Compares consumed contract versions (pinned by bridge_get_contract) against current versions. " +
        "Also shows changelog entries filtered by 'watches' in manifest.json (or all contract changes if no watches). " +
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
    },
    {
      name: "bridge_sync_skills",
      description:
        "Install or update the companion Claude Code skills (context-reader, " +
        "context-feeder, context-bridge) into the current repo's .claude/skills/ folder. " +
        "Run once when onboarding a repo, or after updating the MCP server.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
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
    },
  ],
}));

// ── Call tools ────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    // ── bridge_manifest ────────────────────────────────────────────────────
    case "bridge_manifest": {
      const manifest = await readManifest();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(manifest, null, 2),
          },
        ],
      };
    }

    // ── bridge_get ─────────────────────────────────────────────────────────
    case "bridge_get": {
      const { domain, component } = GetSchema.parse(args);
      const path = contextPath(CONTEXT_ROOT, domain, component);
      assertSafePath(path, [CONTEXT_ROOT]);

      if (component) {
        const content = await safeRead(path);
        if (!content) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No file found: .context/${domain}/${component}.md — use bridge_list to discover what exists`
          );
        }
        return { content: [{ type: "text", text: content }] };
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
    }

    // ── bridge_update ──────────────────────────────────────────────────────
    case "bridge_update": {
      const { domain, component, content } = UpdateSchema.parse(args);
      const path = contextPath(CONTEXT_ROOT, domain, component);
      assertSafePath(path, [CONTEXT_ROOT]);
      await mkdir(join(CONTEXT_ROOT, domain), { recursive: true });
      await writeFile(path, content, "utf-8");
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
    }

    // ── bridge_list ────────────────────────────────────────────────────────
    case "bridge_list": {
      const { domain } = ListSchema.parse(args ?? {});
      const base = domain ? join(CONTEXT_ROOT, domain) : CONTEXT_ROOT;
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
    }

    // ── bridge_get_from ────────────────────────────────────────────────────
    case "bridge_get_from": {
      const { repo, domain, component } = GetFromSchema.parse(args);

      // Resolve repo name from ecosystem, or treat as relative/absolute path
      let repoRoot: string;
      const ecosystem = await readEcosystem();
      if (ecosystem.repos[repo]) {
        repoRoot = resolve(ecosystem.repos[repo].path);
      } else {
        repoRoot = resolve(process.cwd(), repo);
      }

      const externalRoot = join(repoRoot, ".context");
      const path = contextPath(externalRoot, domain, component);
      assertSafePath(path, [externalRoot]);

      if (component) {
        const content = await safeRead(path);
        if (!content) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No file found: ${repo}/.context/${domain}/${component}.md`
          );
        }
        return { content: [{ type: "text", text: content }] };
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
    }

    // ── bridge_get_contract ────────────────────────────────────────────────
    case "bridge_get_contract": {
      const { domain } = ContractGetSchema.parse(args);

      // 1. Try current repo's contracts
      const localPath = contractPath(domain);
      assertSafePath(localPath, [CONTRACTS_ROOT]);
      const localContent = await safeRead(localPath);
      if (localContent) {
        await trackConsumedVersion(domain, localContent, "local");
        return { content: [{ type: "text", text: localContent }] };
      }

      // 2. Search ecosystem repos that expose "contracts"
      const ecosystem = await readEcosystem();
      for (const [repoName, entry] of Object.entries(ecosystem.repos)) {
        if (!entry.exposes.includes("contracts")) continue;
        const repoContractPath = join(
          resolve(entry.path),
          ".context",
          "contracts",
          `${domain}.md`
        );
        const repoContent = await safeRead(repoContractPath);
        if (repoContent) {
          await trackConsumedVersion(domain, repoContent, repoName);
          return {
            content: [
              { type: "text", text: `✓ Resolved from ecosystem repo: ${repoName}` },
              { type: "text", text: repoContent },
            ],
          };
        }
      }

      // 3. Not found — list available repos
      const available = Object.entries(ecosystem.repos)
        .filter(([, e]) => e.exposes.includes("contracts"))
        .map(([n]) => n);
      const hint =
        available.length > 0
          ? ` Ecosystem repos with contracts: ${available.join(", ")}.`
          : " No ecosystem repos expose contracts. Use bridge_register to add repos.";
      throw new McpError(
        ErrorCode.InvalidParams,
        `No contract found for "${domain}" in local or ecosystem repos.${hint}`
      );
    }

    // ── bridge_register ──────────────────────────────────────────────────
    case "bridge_register": {
      const { name: repoName, path: repoPath, exposes, stack } =
        RegisterSchema.parse(args);
      if (!isAbsolute(repoPath)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `path must be absolute (got: "${repoPath}"). Use an absolute path to the repo root.`
        );
      }
      const resolvedPath = resolve(repoPath);
      const ecosystem = await readEcosystem();
      ecosystem.repos[repoName] = {
        path: resolvedPath,
        exposes,
        stack,
        registeredAt: new Date().toISOString().slice(0, 10),
      };
      await writeEcosystem(ecosystem);
      return {
        content: [
          {
            type: "text",
            text: `✓ Registered "${repoName}"\n  exposes: ${exposes.join(", ")}${stack ? `\n  stack: ${stack}` : ""}`,
          },
        ],
      };
    }

    // ── bridge_discover ──────────────────────────────────────────────────
    case "bridge_discover": {
      const { name: repoName } = DiscoverSchema.parse(args ?? {});
      const ecosystem = await readEcosystem();

      if (repoName) {
        const entry = ecosystem.repos[repoName];
        if (!entry) {
          const available = Object.keys(ecosystem.repos);
          throw new McpError(
            ErrorCode.InvalidParams,
            `Repo "${repoName}" not found in ecosystem.${available.length > 0 ? ` Available: ${available.join(", ")}` : " No repos registered yet. Use bridge_register."}`
          );
        }
        // Try to read that repo's manifest for extra detail
        const repoManifest = await safeRead(
          join(resolve(entry.path), ".context", "manifest.json")
        );
        // Return details without exposing the absolute path
        const detail: Record<string, unknown> = {
          name: repoName,
          exposes: entry.exposes,
          stack: entry.stack,
          registeredAt: entry.registeredAt,
        };
        if (repoManifest) {
          try {
            detail.manifest = JSON.parse(repoManifest);
          } catch {
            // ignore parse errors
          }
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(detail, null, 2) },
          ],
        };
      }

      // List all repos
      const repos = Object.entries(ecosystem.repos);
      if (repos.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No repos registered. Use bridge_register to add repos to the ecosystem.",
            },
          ],
        };
      }
      const lines = repos.map(
        ([n, e]) =>
          `  - ${n} (${e.stack ?? "unknown stack"})\n    exposes: ${e.exposes.join(", ")}`
      );
      return {
        content: [
          { type: "text", text: `Ecosystem repos:\n\n${lines.join("\n\n")}` },
        ],
      };
    }

    // ── bridge_update_contract ─────────────────────────────────────────────
    case "bridge_update_contract": {
      const { domain, content } = ContractUpdateSchema.parse(args);
      const path = contractPath(domain);
      assertSafePath(path, [CONTRACTS_ROOT]);
      await mkdir(CONTRACTS_ROOT, { recursive: true });
      await writeFile(path, content, "utf-8");
      await appendChangelog({
        timestamp: new Date().toISOString(),
        repo: await currentRepoName(),
        type: "contract",
        domain,
        component: null,
        summary: extractSummary(content),
      });
      return {
        content: [
          { type: "text", text: `✓ Written: contracts/${domain}.md` },
        ],
      };
    }

    // ── bridge_list_contracts ──────────────────────────────────────────────
    case "bridge_list_contracts": {
      const keys = await listMdFiles(CONTRACTS_ROOT);
      return {
        content: [
          {
            type: "text",
            text:
              keys.length > 0
                ? keys.map((k) => `  - contracts/${k}`).join("\n")
                : "No contracts found.",
          },
        ],
      };
    }

    // ── bridge_manifest_update ─────────────────────────────────────────────
    case "bridge_manifest_update": {
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
      return {
        content: [
          {
            type: "text",
            text: `✓ manifest.json updated.\n\n${JSON.stringify(merged, null, 2)}`,
          },
        ],
      };
    }

    // ── bridge_changes ──────────────────────────────────────────────────
    case "bridge_changes": {
      const { since } = ChangesSchema.parse(args ?? {});
      const repoName = await currentRepoName();
      const manifest = await readManifest();
      const watches = manifest.watches as Record<string, string[]> | undefined;
      const ecosystem = await readEcosystem();
      const myEntry = ecosystem.repos[repoName];

      // Determine cursor: explicit `since`, or this repo's lastCheckedAt, or epoch
      let cursor: string;
      if (since) {
        cursor = since;
      } else if (myEntry?.lastCheckedAt) {
        cursor = myEntry.lastCheckedAt;
      } else {
        cursor = "1970-01-01T00:00:00Z";
      }

      // ── Part 1: changelog entries since cursor ──
      const allEntries = await readChangelog();
      const relevant = allEntries.filter((e) => {
        if (e.repo === repoName) return false;
        if (e.timestamp <= cursor) return false;
        if (watches) {
          const watchedDomains = watches[e.repo];
          if (!watchedDomains) return false;
          return watchedDomains.includes(e.domain) || watchedDomains.includes(e.type);
        }
        return e.type === "contract";
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
        // Source repo no longer in ecosystem — surface as orphan dependency
        if (!ecosystem.repos[pin.source]) {
          driftLines.push(
            `  ⚠ contract "${contractDomain}": pinned to v${pin.version} from "${pin.source}", but "${pin.source}" is no longer registered in the ecosystem`
          );
          continue;
        }

        const sourcePath = join(
          resolve(ecosystem.repos[pin.source].path),
          ".context",
          "contracts",
          `${contractDomain}.md`
        );
        const currentContent = await safeRead(sourcePath);

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

      // ── Update lastCheckedAt cursor ──
      if (myEntry) {
        myEntry.lastCheckedAt = new Date().toISOString();
        await writeEcosystem(ecosystem);
      }

      // ── Build response ──
      const sections: string[] = [];

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
    }

    // ── bridge_sync_skills ────────────────────────────────────────────────
    case "bridge_sync_skills": {
      const targetRoot = join(process.cwd(), ".claude", "skills");

      if (!existsSync(SKILLS_SOURCE)) {
        throw new McpError(
          ErrorCode.InternalError,
          `Skills source not found. Is the MCP server installed correctly?`
        );
      }

      // Walk a skill directory and return relative paths of all files
      async function walkFiles(root: string): Promise<string[]> {
        const out: string[] = [];
        async function walk(dir: string, prefix: string): Promise<void> {
          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const sub = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) {
              await walk(join(dir, e.name), sub);
            } else if (e.isFile()) {
              out.push(sub);
            }
          }
        }
        await walk(root, "");
        return out;
      }

      const added: string[] = [];
      const updated: string[] = [];
      const unchanged: string[] = [];

      for (const skill of BRIDGE_SKILLS) {
        const src = join(SKILLS_SOURCE, skill);
        if (!existsSync(src)) continue;
        const dest = join(targetRoot, skill);

        const files = await walkFiles(src);
        for (const rel of files) {
          const srcFile = join(src, rel);
          const destFile = join(dest, rel);
          const newContent = await readFile(srcFile, "utf-8");
          const oldContent = await safeRead(destFile);
          const label = `${skill}/${rel}`;

          if (oldContent === null) {
            await mkdir(join(destFile, ".."), { recursive: true });
            await writeFile(destFile, newContent, "utf-8");
            added.push(label);
          } else if (oldContent !== newContent) {
            await writeFile(destFile, newContent, "utf-8");
            updated.push(label);
          } else {
            unchanged.push(label);
          }
        }
      }

      const lines: string[] = [];
      if (added.length > 0) {
        lines.push(`Added (${added.length}):\n${added.map((f) => `  + ${f}`).join("\n")}`);
      }
      if (updated.length > 0) {
        lines.push(`Updated (${updated.length}):\n${updated.map((f) => `  ~ ${f}`).join("\n")}`);
      }
      if (added.length === 0 && updated.length === 0) {
        lines.push(`✓ All ${unchanged.length} skill files already up to date.`);
      } else {
        lines.push(`✓ Synced to .claude/skills/ (${unchanged.length} unchanged).`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

// ─── Deep merge util ──────────────────────────────────────────────────────────

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(CONTEXT_ROOT, { recursive: true });
  if (!existsSync(MANIFEST_PATH)) {
    await writeManifest({ version: "1.0", domains: {} });
    console.error(`[context-bridge] Initialized manifest at ${MANIFEST_PATH}`);
  }

  // Ensure ecosystem directory exists
  await mkdir(ECOSYSTEM_ROOT, { recursive: true });

  console.error(`[context-bridge] CONTEXT_ROOT   = ${CONTEXT_ROOT}`);
  console.error(`[context-bridge] CONTRACTS_ROOT = ${CONTRACTS_ROOT}`);
  console.error(`[context-bridge] ECOSYSTEM_PATH = ${ECOSYSTEM_PATH}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[context-bridge] Context Bridge MCP running on stdio");
}

main().catch((err) => {
  console.error("[context-bridge] Fatal:", err);
  process.exit(1);
});
