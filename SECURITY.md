# Security Policy

## Supported versions

Only the latest minor release receives security updates.

| Version | Supported |
|---|---|
| 1.0.x   | ✅ |
| < 1.0   | ❌ |

## Reporting a vulnerability

**Please do not report security issues via public GitHub issues,
discussions, or pull requests.**

Use [GitHub's private vulnerability reporting form](https://github.com/Bantarus/context-bridge-mcp/security/advisories/new)
to file a private security advisory. You will receive an acknowledgement
within 72 hours.

When reporting, please include:

- A description of the issue and its potential impact
- Steps to reproduce — a minimal repro is ideal
- The version of `context-bridge-mcp` affected (commit SHA or tag)
- How the bridge was invoked (Claude Desktop, Claude Code CLI, an embedding
  host, or `node dist/index.js` directly)

## In scope

- Path traversal or unsafe file access via any of the bridge tools
- Information disclosure — e.g., absolute paths leaked through tool
  responses
- Injection vulnerabilities in tool arguments
- Supply-chain issues in our published release artifacts
  (`.mcpb` bundle, github-install tarball)
- Concurrent-write data corruption in `ecosystem.json` /
  `manifest.json` / `changelog.jsonl`

## Out of scope

- Misconfiguration in a consumer repo — e.g., a `manifest.json` whose
  authors intentionally exposed sensitive data
- Denial of service via large `.context/` payloads — the bridge does not
  impose size limits by design
- Issues that require the attacker to already control the host filesystem
  (the bridge trusts the filesystem it runs on)
- Test code under `test/` — non-production
- Issues in `@modelcontextprotocol/sdk`, `zod`, or other dependencies —
  please report those upstream

## What to expect

1. **Acknowledgement** within 72 hours
2. **First assessment** within 7 days
3. **Fix or mitigation** for valid reports within 30 days (faster for
   high-severity)
4. **Public disclosure** via a GitHub Security Advisory once a fix is
   released, with credit to the reporter — unless you prefer to remain
   anonymous

## Hardening recommendations for operators

- Pin `context-bridge-mcp` to a specific release tag in production
  (`npm install github:Bantarus/context-bridge-mcp#v1.0.0`)
- Run the bridge under an unprivileged user, not root
- Treat `ECOSYSTEM_ROOT` as security-sensitive — it controls cross-repo
  resolution; restrict its permissions to the user that owns the bridge
- Audit the `.context/` content of any repo before consuming its contracts
  via the bridge
- Keep companion skills up-to-date via `bridge_sync_skills` so behavior
  matches the deployed server version
