// ─── Markdown text helpers (pure) ────────────────────────────────────────────

export function extractVersion(content: string): string | null {
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

export function extractSummary(content: string): string {
  const line = content.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim().replace(/^#+\s*/, "").slice(0, 80);
}

/** First entry under a contract's `## Changelog` heading (newest first by convention). */
export function extractNewestChangelogLine(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+changelog\s*$/i.test(l.trim()));
  if (start === -1) return null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) return null;
    const text = line.replace(/^([-*+]|\d+[.)])\s+/, "").trim();
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }
  return null;
}

/** Changelog summary for a contract: "1.9 -> 1.10: <newest changelog line>". */
export function contractSummary(
  previous: string | null,
  content: string
): { summary: string; version: string | null } {
  const version = extractVersion(content);
  if (!version) return { summary: extractSummary(content), version: null };
  const head =
    previous === null
      ? version
      : previous === version
        ? `${version} (version unchanged)`
        : `${previous} -> ${version}`;
  const note = extractNewestChangelogLine(content);
  return { summary: note ? `${head}: ${note}` : head, version };
}
