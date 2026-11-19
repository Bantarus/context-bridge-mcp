import { mkdir } from "fs/promises";
import { z } from "zod";
import { cfg } from "../config.js";
import { invalidParams } from "../errors.js";
import { safeRead, listMdFiles, writeFileAtomic } from "../fsutil.js";
import { assertSafePath } from "../paths.js";
import { readEcosystem, readRepoContract } from "../ecosystem.js";
import { currentRepoName } from "../manifest.js";
import { lastLoggedVersion } from "../changelog.js";
import { contractPath, logContractChange, trackConsumedVersion } from "../contracts.js";
import { extractVersion } from "../text.js";
import type { ToolDef } from "../types.js";

const ContractGetSchema = z.object({
  domain: z.string().min(1),
});

const ContractUpdateSchema = z.object({
  domain: z.string().min(1),
  content: z.string().min(1),
});

export const bridgeGetContract: ToolDef = {
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
  async handler(args, _ctx) {
    const { domain } = ContractGetSchema.parse(args);

    // 1. Try current repo's contracts
    const localPath = contractPath(domain);
    assertSafePath(localPath, [cfg().contractsRoot]);
    const localContent = await safeRead(localPath);
    if (localContent) {
      await trackConsumedVersion(domain, localContent, "local");
      return { content: [{ type: "text", text: localContent, verbatim: true }] };
    }

    // 2. Search ecosystem repos that expose "contracts"
    const ecosystem = await readEcosystem();
    const unreachable: string[] = [];
    for (const [repoName, entry] of Object.entries(ecosystem.repos)) {
      if (!entry.exposes.includes("contracts")) continue;
      const result = await readRepoContract(repoName, entry, domain);
      if ("error" in result) {
        unreachable.push(result.error);
        continue;
      }
      const repoContent = result.content;
      if (repoContent) {
        await trackConsumedVersion(domain, repoContent, repoName);
        return {
          content: [
            { type: "text", text: `✓ Resolved from ecosystem repo: ${repoName}` },
            { type: "text", text: repoContent, verbatim: true },
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
    const unreachableHint =
      unreachable.length > 0
        ? `\nUnreachable from this environment (not searched):\n${unreachable.map((u) => `  - ${u}`).join("\n")}`
        : "";
    throw invalidParams(`No contract found for "${domain}" in local or ecosystem repos.${hint}${unreachableHint}`
    );
  },
};

export const bridgeUpdateContract: ToolDef = {
  name: "bridge_update_contract",
  description:
    "Write or overwrite an API contract file. Use when adding a new endpoint, event shape, or shared type. " +
    "Logs the change with its version (from ## Version) and newest ## Changelog line, e.g. '1.9 -> 1.10: <line>'.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string" },
      content: { type: "string", description: "Full markdown content" },
    },
    required: ["domain", "content"],
  },
  async handler(args, _ctx) {
    const { domain, content } = ContractUpdateSchema.parse(args);
    const path = contractPath(domain);
    assertSafePath(path, [cfg().contractsRoot]);
    // The version being replaced: the file on disk, else what was last logged
    const before = await safeRead(path);
    const previous =
      (before !== null ? extractVersion(before) : null) ??
      (await lastLoggedVersion(await currentRepoName(), "contract", domain));
    await mkdir(cfg().contractsRoot, { recursive: true });
    await writeFileAtomic(path, content);
    const summary = await logContractChange(domain, content, previous);
    return {
      content: [
        { type: "text", text: `✓ Written: contracts/${domain}.md\n  logged: ${summary}` },
      ],
    };
  },
};

export const bridgePublishContract: ToolDef = {
  name: "bridge_publish_contract",
  description:
    "Log a contract you edited in place in contracts/<domain>.md, without resending its content. " +
    "Records the version change since the last logged version and the newest ## Changelog line, " +
    "so consumers see it in bridge_changes.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Contract domain name" },
    },
    required: ["domain"],
  },
  async handler(args, _ctx) {
    const { domain } = ContractGetSchema.parse(args);
    const path = contractPath(domain);
    assertSafePath(path, [cfg().contractsRoot]);
    const content = await safeRead(path);
    if (content === null) {
      throw invalidParams(`No contract at contracts/${domain}.md — write it first (or use bridge_update_contract)`
      );
    }
    // Edited in place: the file already holds the new version, so compare
    // with the last version this repo logged
    const previous = await lastLoggedVersion(await currentRepoName(), "contract", domain);
    const summary = await logContractChange(domain, content, previous);
    const hint = extractVersion(content)
      ? ""
      : "\n  ⚠ no ## Version section — consumers can't detect drift for this contract";
    return {
      content: [{ type: "text", text: `✓ Logged contracts/${domain}.md: ${summary}${hint}` }],
    };
  },
};

export const bridgeListContracts: ToolDef = {
  name: "bridge_list_contracts",
  description: "List all existing contract files.",
  inputSchema: { type: "object", properties: {}, required: [] },
  async handler(_args, _ctx) {
    const keys = await listMdFiles(cfg().contractsRoot);
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
  },
};
