import { join, resolve } from "path";
import { z } from "zod";
import { cfg, ownRepoRoot } from "../config.js";
import { invalidParams } from "../errors.js";
import { safeRead } from "../fsutil.js";
import { toCanonicalPath, toLocalPath, resolveStoredDir } from "../paths.js";
import { readEcosystem, updateEcosystem, repoRoot } from "../ecosystem.js";
import { listPublishedSkills } from "../skills.js";
import { registrationNotice } from "../identity.js";
import type { ToolDef } from "../types.js";

const RegisterSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  exposes: z.array(z.string()).min(1),
  stack: z.string().optional(),
  contractsPath: z.string().min(1).optional(),
});

const DiscoverSchema = z.object({
  name: z.string().optional(),
});

export const bridgeRegister: ToolDef = {
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
        description:
          "Absolute path to the repo root, in any notation: /home/..., /mnt/c/..., C:\\..., " +
          "or \\\\wsl.localhost\\<Distro>\\.... Stored in a form every Windows/WSL environment can translate.",
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
      contractsPath: {
        type: "string",
        description:
          "Absolute path to the repo's contracts folder, only if it is NOT <path>/.context/contracts. " +
          "Filled in automatically when registering the current repo with a custom CONTRACTS_ROOT.",
      },
    },
    required: ["name", "path", "exposes"],
  },
  async handler(args, _ctx) {
    const { name: repoName, path: repoPath, exposes, stack, contractsPath } =
      RegisterSchema.parse(args);
    const canonicalPath = toCanonicalPath(repoPath);
    if (!canonicalPath) {
      throw invalidParams(`path must be absolute (got: "${repoPath}"). Use an absolute path to the repo root.`
      );
    }

    // Contracts outside <repo>/.context/contracts must be recorded so other
    // repos can find them. Registering the current repo with a custom
    // cfg().contractsRoot fills this in automatically.
    let canonicalContracts: string | undefined;
    if (contractsPath) {
      canonicalContracts = toCanonicalPath(contractsPath) ?? undefined;
      if (!canonicalContracts) {
        throw invalidParams(`contractsPath must be absolute (got: "${contractsPath}").`
        );
      }
    } else {
      const local = toLocalPath(canonicalPath);
      const isCurrentRepo =
        "path" in local && resolve(local.path) === ownRepoRoot();
      if (isCurrentRepo && cfg().contractsRoot !== join(cfg().contextRoot, "contracts")) {
        canonicalContracts = toCanonicalPath(cfg().contractsRoot) ?? undefined;
      }
    }

    await updateEcosystem((ecosystem) => {
      const previous = ecosystem.repos[repoName];
      ecosystem.repos[repoName] = {
        // Re-registering must not reset this repo's pins and changelog cursor
        ...previous,
        path: canonicalPath,
        contractsPath: canonicalContracts,
        exposes,
        stack,
        registeredAt: new Date().toISOString().slice(0, 10),
      };
      if (!canonicalContracts) delete ecosystem.repos[repoName].contractsPath;
    });

    const reach = resolveStoredDir(canonicalPath, `repo "${repoName}"`);
    const warning =
      "error" in reach ? `\n  ⚠ ${reach.error}` : "";
    return {
      content: [
        {
          type: "text",
          text: `✓ Registered "${repoName}"\n  exposes: ${exposes.join(", ")}${stack ? `\n  stack: ${stack}` : ""}${warning}`,
        },
      ],
    };
  },
};

export const bridgeDiscover: ToolDef = {
  name: "bridge_discover",
  description:
    "Discover repos registered in the ecosystem. Call with no args to list " +
    "all repos, their exposed domains, and the skills they publish. Pass a name to get details " +
    "including its manifest and published skills. Use the repo name with bridge_get_from to " +
    "read its files, or with bridge_install_skill to install one of its skills.",
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
  async handler(args, { redact }) {
    const { name: repoName } = DiscoverSchema.parse(args ?? {});
    const ecosystem = await readEcosystem();

    if (repoName) {
      const entry = ecosystem.repos[repoName];
      if (!entry) {
        const available = Object.keys(ecosystem.repos);
        throw invalidParams(`Repo "${repoName}" not found in ecosystem.${available.length > 0 ? ` Available: ${available.join(", ")}` : " No repos registered yet. Use bridge_register."}`
        );
      }
      // Try to read that repo's manifest for extra detail
      const root = repoRoot(repoName, entry);
      const repoManifest =
        "path" in root
          ? await safeRead(join(root.path, ".context", "manifest.json"))
          : null;
      // Return details without exposing the absolute path
      const detail: Record<string, unknown> = {
        name: repoName,
        exposes: entry.exposes,
        stack: entry.stack,
        registeredAt: entry.registeredAt,
        reachable: "path" in root,
      };
      // This block carries the repo's own manifest and skill descriptions
      // verbatim, so redact the bridge's own field here
      if ("error" in root) detail.unreachableReason = redact(root.error);
      if ("path" in root && entry.exposes.includes("skills")) {
        detail.skills = (await listPublishedSkills(join(root.path, ".context"))).map(
          ({ name, version, description }) => ({ name, version, description })
        );
      }
      if (repoManifest) {
        try {
          detail.manifest = JSON.parse(repoManifest);
        } catch {
          // ignore parse errors
        }
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(detail, null, 2), verbatim: true },
        ],
      };
    }

    // List all repos
    const repos = Object.entries(ecosystem.repos);
    const notice = await registrationNotice();
    if (repos.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No repos registered. Use bridge_register to add repos to the ecosystem." +
              (notice ? `\n\n${notice}` : ""),
          },
        ],
      };
    }
    const lines = await Promise.all(repos.map(async ([n, e]) => {
      const reach = repoRoot(n, e);
      const flag = "error" in reach ? "\n    ⚠ unreachable from this environment" : "";
      let skills = "";
      if ("path" in reach && e.exposes.includes("skills")) {
        const published = await listPublishedSkills(join(reach.path, ".context"));
        skills = published
          .map((sk) => {
            const desc = sk.description
              ? ` — ${sk.description.length > 100 ? `${sk.description.slice(0, 97)}...` : sk.description}`
              : "";
            return `\n    skill: ${sk.name} ${sk.version ?? "(unversioned)"}${desc}`;
          })
          .join("");
      }
      return `  - ${n} (${e.stack ?? "unknown stack"})\n    exposes: ${e.exposes.join(", ")}${skills}${flag}`;
    }));
    return {
      content: [
        {
          type: "text",
          text: `Ecosystem repos:\n\n${lines.join("\n\n")}${notice ? `\n\n${notice}` : ""}`,
        },
      ],
    };
  },
};
