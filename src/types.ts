// ─── Shared types ────────────────────────────────────────────────────────────

export interface ConsumedVersion {
  version: string;
  source: string;       // which repo the contract was read from
  consumedAt: string;   // ISO timestamp of when it was read
}

export interface EcosystemEntry {
  path: string;            // canonical form — see toCanonicalPath()
  contractsPath?: string;  // canonical; only set when contracts live outside <path>/.context/contracts
  exposes: string[];
  stack?: string;
  registeredAt: string;
  lastCheckedAt?: string;
  changelogCursor?: number;  // number of complete changelog.jsonl lines already seen
  consumedVersions?: Record<string, ConsumedVersion>;  // keyed by contract domain
}

export interface Ecosystem {
  version: string;
  repos: Record<string, EcosystemEntry>;
}

export interface ChangelogEntry {
  timestamp: string;
  repo: string;
  type: "context" | "contract" | "manifest" | "skill" | "message";
  domain: string;
  component: string | null;
  summary: string;
  version?: string;   // contract/skill version this entry published
  to?: string;        // message addressee (repo name)
}

export type Manifest = Record<string, unknown>;

export interface TextBlock {
  type: "text";
  text: string;
  /**
   * `verbatim` marks a repo's own document (context file, contract,
   * manifest), passed through exactly as its owner wrote it — what a
   * document reveals is the owner's choice. Everything else is a bridge
   * message and is redacted.
   */
  verbatim?: boolean;
}

export interface ToolResult {
  content: TextBlock[];
}

export interface ToolContext {
  redact: (text: string) => string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown> | undefined, ctx: ToolContext) => Promise<ToolResult>;
}

export const text = (t: string): TextBlock => ({ type: "text", text: t });
export const verbatim = (t: string): TextBlock => ({ type: "text", text: t, verbatim: true });
