/**
 * E2E C — Agent surfaces version drift when asked.
 *
 * Pre-seed an ecosystem where repo-a has consumed users@1.0 from repo-b,
 * but repo-b has since bumped it to 2.0. Ask the agent to check for drift.
 * The agent should call bridge_changes and the response should reference
 * the users contract and a version delta.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  runClaudeHeadless,
  makeE2EFixture,
  headlessEnabled,
} from "../helpers/claude-headless.js";

describe.runIf(headlessEnabled)("E2E C — Agent detects contract drift", () => {
  it(
    "reports drift on a consumed contract that has been bumped upstream",
    async () => {
      const fx = makeE2EFixture({
        manifest: {
          version: "1.0",
          project: "repo-a",
          domains: {},
        },
      });

      // Build a sibling "repo-b" with a users contract at v2.0
      const repoB = mkdtempSync(join(tmpdir(), "bridge-e2e-repoB-"));
      mkdirSync(join(repoB, ".context", "contracts"), { recursive: true });
      writeFileSync(
        join(repoB, ".context", "manifest.json"),
        JSON.stringify({ version: "1.0", project: "repo-b" }),
        "utf-8"
      );
      writeFileSync(
        join(repoB, ".context", "contracts", "users.md"),
        "# Users\n\n## Version\n2.0\n\nGET /users\nDELETE /users/:id",
        "utf-8"
      );

      // Pre-seed the ecosystem.json with both repos and a stale pin in repo-a
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
                consumedVersions: {
                  users: {
                    version: "1.0",
                    source: "repo-b",
                    consumedAt: "2026-04-15T10:00:00Z",
                  },
                },
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
          `Check the ecosystem for any contract version drift on contracts ` +
          `this repo has consumed. Use the context-bridge MCP — specifically ` +
          `bridge_changes — and report whether anything is out of date.`;

        const r = await runClaudeHeadless({
          cwd: fx.cwd,
          ecosystemRoot: fx.ecoRoot,
          prompt,
        });

        if (r.totalCostUsd !== undefined) {
          console.log(`  E2E C cost: $${r.totalCostUsd.toFixed(4)}`);
        }
        expect(r.exitCode).toBe(0);

        // The agent's reply should reference the users contract and reflect
        // some version awareness. We allow latitude on phrasing.
        const reply = r.result.toLowerCase();
        expect(reply).toContain("users");
        expect(reply).toMatch(/drift|1\.0|2\.0|out of date|outdated|update/);
      } finally {
        fx.cleanup();
        rmSync(repoB, { recursive: true, force: true });
      }
    },
    90_000
  );
});
