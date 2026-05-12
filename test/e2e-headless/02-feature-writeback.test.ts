/**
 * E2E B — Agent writes context after a "feature" instruction.
 *
 * After a user says "I just added X, document it", the agent should use
 * `bridge_update` to write a context file. We assert the file ends up in
 * the right location with content that mentions the feature.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  runClaudeHeadless,
  makeE2EFixture,
  headlessEnabled,
} from "../helpers/claude-headless.js";

describe.runIf(headlessEnabled)("E2E B — Agent writes back after a feature", () => {
  it(
    "creates .context/api/users.md when asked to document new endpoints",
    async () => {
      const fx = makeE2EFixture({
        manifest: {
          version: "1.0",
          project: "test-repo",
          domains: { api: [] },
        },
      });
      try {
        const prompt =
          `I just added two endpoints to my API: GET /users and POST /users. ` +
          `Use the context-bridge MCP to document them. ` +
          `Call bridge_update with domain="api", component="users", and ` +
          `content describing both endpoints (one short markdown paragraph each).`;

        const r = await runClaudeHeadless({
          cwd: fx.cwd,
          ecosystemRoot: fx.ecoRoot,
          prompt,
        });

        if (r.totalCostUsd !== undefined) {
          console.log(`  E2E B cost: $${r.totalCostUsd.toFixed(4)}`);
        }
        expect(r.exitCode).toBe(0);

        const filePath = join(fx.ctxRoot, "api", "users.md");
        expect(existsSync(filePath)).toBe(true);
        const content = readFileSync(filePath, "utf-8");
        // Loose assertions — content varies but should mention both verbs
        expect(content.toLowerCase()).toMatch(/get/);
        expect(content.toLowerCase()).toMatch(/post/);
        expect(content.toLowerCase()).toContain("users");
      } finally {
        fx.cleanup();
      }
    },
    90_000
  );
});
