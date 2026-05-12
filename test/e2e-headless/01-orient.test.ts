/**
 * E2E A — Agent orients itself in a fresh repo.
 *
 * Given a brand-new repo and a clear instruction to register it, the agent
 * should pick `bridge_register` from the tool list, supply the right
 * arguments, and the ecosystem.json should reflect the registration.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  runClaudeHeadless,
  makeE2EFixture,
  headlessEnabled,
} from "../helpers/claude-headless.js";

describe.runIf(headlessEnabled)("E2E A — Agent registers a fresh repo", () => {
  it(
    "registers the current repo in the ecosystem when asked",
    async () => {
      const fx = makeE2EFixture();
      try {
        const prompt =
          `Use the context-bridge MCP tools to register this repo. ` +
          `Pass these arguments to bridge_register: ` +
          `name="test-repo", path="${fx.cwd}", exposes=["routes"], stack="Node.js". ` +
          `Then confirm the registration succeeded.`;

        const r = await runClaudeHeadless({
          cwd: fx.cwd,
          ecosystemRoot: fx.ecoRoot,
          prompt,
        });

        if (r.totalCostUsd !== undefined) {
          console.log(`  E2E A cost: $${r.totalCostUsd.toFixed(4)}`);
        }
        expect(r.exitCode).toBe(0);

        // The ground truth: ecosystem.json should have the entry
        const ecoPath = join(fx.ecoRoot, "ecosystem.json");
        expect(existsSync(ecoPath)).toBe(true);
        const eco = JSON.parse(readFileSync(ecoPath, "utf-8"));
        expect(eco.repos["test-repo"]).toMatchObject({
          path: fx.cwd,
          exposes: ["routes"],
          stack: "Node.js",
        });
      } finally {
        fx.cleanup();
      }
    },
    90_000
  );
});
