/**
 * E2E D — Cross-repo contract read automatically pins the consumed version.
 *
 * Repo A has no local users contract; repo B exposes one at v2.0. When the
 * agent reads the contract via `bridge_get_contract`, the bridge silently
 * pins consumedVersions["users"] in repo A's ecosystem entry. This test
 * checks the SIDE EFFECT (filesystem state), not the agent's reply.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runClaudeHeadless,
  makeE2EFixture,
  headlessEnabled,
} from "../helpers/claude-headless.js";

describe.runIf(headlessEnabled)(
  "E2E D — Cross-repo contract read pins the version",
  () => {
    it(
      "auto-pins consumedVersions when the agent reads a contract from another repo",
      async () => {
        const fx = makeE2EFixture({
          manifest: { version: "1.0", project: "repo-a", domains: {} },
        });

        const repoB = mkdtempSync(join(tmpdir(), "bridge-e2e-repoB-"));
        mkdirSync(join(repoB, ".context", "contracts"), { recursive: true });
        writeFileSync(
          join(repoB, ".context", "manifest.json"),
          JSON.stringify({ version: "1.0", project: "repo-b" }),
          "utf-8"
        );
        writeFileSync(
          join(repoB, ".context", "contracts", "users.md"),
          "# Users (from repo-b)\n\n## Version\n2.0",
          "utf-8"
        );

        // Pre-register both repos so the bridge can resolve "users" via the ecosystem
        writeFileSync(
          join(fx.ecoRoot, "ecosystem.json"),
          JSON.stringify(
            {
              version: "1.0",
              repos: {
                "repo-a": {
                  path: fx.cwd,
                  exposes: ["routes"],
                  registeredAt: "2026-04-01",
                },
                "repo-b": {
                  path: repoB,
                  exposes: ["contracts"],
                  registeredAt: "2026-04-01",
                },
              },
            },
            null,
            2
          ),
          "utf-8"
        );

        try {
          const prompt =
            `Fetch the "users" API contract using context-bridge ` +
            `(bridge_get_contract) and summarize what endpoints it documents.`;

          const r = await runClaudeHeadless({
            cwd: fx.cwd,
            ecosystemRoot: fx.ecoRoot,
            prompt,
          });

          if (r.totalCostUsd !== undefined) {
            console.log(`  E2E D cost: $${r.totalCostUsd.toFixed(4)}`);
          }
          expect(r.exitCode).toBe(0);

          // The deterministic assertion: a pin must now exist in ecosystem.json
          const eco = JSON.parse(
            readFileSync(join(fx.ecoRoot, "ecosystem.json"), "utf-8")
          );
          expect(eco.repos["repo-a"].consumedVersions.users).toMatchObject({
            version: "2.0",
            source: "repo-b",
          });
        } finally {
          fx.cleanup();
          rmSync(repoB, { recursive: true, force: true });
        }
      },
      90_000
    );
  }
);
