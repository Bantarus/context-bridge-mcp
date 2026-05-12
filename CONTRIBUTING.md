# Contributing to Context Bridge MCP

Thanks for your interest. The bridge is small, single-file, and deliberately
unopinionated — contributions that keep it that way are very welcome.

## Quick start

```bash
git clone https://github.com/Bantarus/context-bridge-mcp.git
cd context-bridge-mcp
npm install   # the `prepare` hook builds dist/ for you
npm test
```

Requires Node ≥ 20.11.

## What we welcome

- **Bug fixes** — small, focused, with a test that demonstrates the bug
- **Documentation improvements** — including fixes for doc-vs-code gaps
- **New or refined tools**, after discussion in an issue
- **Coverage gaps** in the test suite

## What we'd rather discuss first

- **Major refactors** — the single-file architecture is intentional; let's
  align on direction before code
- **New runtime dependencies** — the bridge currently ships only
  `@modelcontextprotocol/sdk` and `zod`; please open an issue if you think
  another is justified
- **Project-specific features** — the server has zero project knowledge by
  design and we want to keep it that way

## Development workflow

The server lives in a single file: [src/index.ts](src/index.ts). Everything
is filesystem I/O against `.context/` folders, with shared state in
`~/.context-bridge/`.

```bash
npm run dev          # tsx watch — no build step, instant reload
npm run build        # compile dist/index.js with shebang
npm run typecheck    # tsc --noEmit
npm test             # unit + integration + scenarios
npm run test:watch   # vitest watch mode
npm run test:coverage
```

## Tests

The suite is split into four layers ([details](README.md#testing)):

| Layer | What it tests | When to add |
|---|---|---|
| Unit | Pure helpers (`deepMerge`, `extractVersion`, etc.) | If you touched them |
| Integration | Each MCP tool, exercised via real Client over stdio | If you touched any handler |
| Scenarios | Multi-repo journeys | If your change crosses repos |
| Headless E2E | Real `claude -p` driving the bridge | Optional (local-only, costs a few cents) |

Vitest auto-discovers `test/**/*.test.ts`. Headless E2E tests are gated by
`RUN_E2E_HEADLESS=1` and use your Claude Code subscription auth — they do
not run in CI.

## Keep the companion skills in sync

When you change a tool's name, signature, or behavior, also update the
three companion skills in `.claude/skills/`:

- `context-reader/SKILL.md` — what Claude Code reads at session start
- `context-feeder/SKILL.md` — how Claude Code writes back after implementing
- `context-bridge/SKILL.md` — cross-repo coordination guide

Stale skills produce incorrect tool calls and silently fail. See the
IMPORTANT block in [CLAUDE.md](CLAUDE.md) for the full rationale.

## Style and conventions

- ESM throughout (`"type": "module"`)
- Minimal comments: explain **why**, not what — identifiers carry the what
- No new abstractions for hypothetical needs
- Every external path goes through `assertSafePath`
- Writes to `manifest.json` / `ecosystem.json` go through `writeFileAtomic`
- The boot guard at the bottom of `src/index.ts` keeps the module
  import-safe — please don't remove it

## Submitting a pull request

1. Fork and create a feature branch from `master`
2. Run `npm test && npm run typecheck` locally
3. Open a PR with a short description: what changed and why
4. The CI matrix (5 jobs across Linux/macOS/Windows × Node 20/22/24) runs
   automatically
5. Discussion happens in the PR; squash-merges keep history readable

## Security issues

Do **not** open a public issue for vulnerabilities. See
[SECURITY.md](SECURITY.md) for the private reporting process.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
