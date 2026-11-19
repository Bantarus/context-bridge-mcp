import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { loadConfig, setConfig } from "./config.js";
import { openBus } from "./bus/core.js";
import { ALIASES, OPERATIONS, findOperation, validateInput, type Input, type Operation } from "./bus/ops.js";
import { readEcosystem } from "./ecosystem.js";
import { BridgeError } from "./errors.js";
import { buildPathRedactor } from "./redact.js";

// ─── CLI adapter: `beam <command>` ───────────────────────────────────────────
//
// The same operations as the bridge_* bus tools, for the human (or an agent
// in a shell). Same rendering, same path redaction. Exit codes: 0 done,
// 1 refused or not found (reason on stderr), 2 usage error.

export const CLI_NAME = "beam";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string | null>;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`),
  readStdin: async () => {
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
  },
};

class UsageError extends Error {}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The nearest directory at or above `start` that has a .context/ folder. */
export function findRepoRoot(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".context"))) return dir;
    if (dirname(dir) === dir) return resolve(start);
  }
}

function helpText(cmd?: string): string {
  const alias = ALIASES.find((a) => a.name === cmd);
  const op = cmd ? findOperation(cmd) : undefined;
  if (alias) return `${CLI_NAME} ${alias.name} ${alias.usage}\n\n${alias.description}.`;
  if (op) {
    const params = Object.entries(op.params)
      .map(([k, s]) => `  ${s.positional !== undefined ? `<${k}>` : `--${s.flag ?? kebab(k)}`}  ${s.description}`)
      .join("\n");
    return `${CLI_NAME} ${op.name} ${op.usage}\n\n${op.description}\n\n${params}`;
  }
  const rows = [
    ...OPERATIONS.map((o) => [`${o.name} ${o.usage}`, ""]),
    ...ALIASES.map((a) => [`${a.name} ${a.usage}`, a.description]),
  ];
  return [
    `${CLI_NAME} — messages between the repos of a Context Bridge ecosystem`,
    "",
    "Commands:",
    ...rows.map(([u, d]) => `  ${CLI_NAME} ${u}${d ? `\n      ${d}` : ""}`),
    `  ${CLI_NAME} help [command]`,
    "",
    "Options: --json (structured output), --repo <path> (act for that repo; default: the nearest",
    "folder with a .context/ at or above the current directory). CONTEXT_ROOT and ECOSYSTEM_ROOT are",
    "honoured as by the MCP server.",
  ].join("\n");
}

interface Parsed {
  op: Operation;
  input: Input;
  json: boolean;
  repo?: string;
  file?: string;
}

export function parseArgs(argv: string[]): Parsed | { help: string } {
  const args = [...argv];
  let json = false;
  let repo: string | undefined;
  let file: string | undefined;
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") return { help: helpText(positionals[0]) };
    else if (a.startsWith("--") || a === "-m") {
      const eq = a.indexOf("=");
      const key = a === "-m" ? "message" : eq > 0 ? a.slice(2, eq) : a.slice(2);
      const value = eq > 0 && a !== "-m" ? a.slice(eq + 1) : args.shift();
      if (value === undefined) throw new UsageError(`${a} needs a value`);
      if (key === "repo") repo = value;
      else if (key === "file") file = value;
      else flags[key] = value;
    } else positionals.push(a);
  }

  const [cmd, ...rest] = positionals;
  if (!cmd || cmd === "help") return { help: helpText(rest[0]) };

  const alias = ALIASES.find((a) => a.name === cmd);
  const op = findOperation(alias?.of ?? cmd);
  if (!op) throw new UsageError(`Unknown command "${cmd}". Run "${CLI_NAME} help".`);

  const input: Input = {};
  if (alias) {
    if (rest.length !== 1) throw new UsageError(`Usage: ${CLI_NAME} ${alias.name} ${alias.usage}`);
    input[alias.param] = rest[0];
  } else {
    const byPosition = Object.entries(op.params).filter(([, s]) => s.positional !== undefined);
    if (rest.length > byPosition.length) {
      throw new UsageError(`Too many arguments. Usage: ${CLI_NAME} ${op.name} ${op.usage}`);
    }
    for (const [key, spec] of byPosition) {
      if (rest[spec.positional!] !== undefined) input[key] = rest[spec.positional!];
    }
  }
  for (const [flag, value] of Object.entries(flags)) {
    const hit = Object.entries(op.params).find(
      ([k, s]) => flag === (s.flag ?? kebab(k)) || flag === k || flag === kebab(k)
    );
    if (!hit) throw new UsageError(`Unknown option --${flag} for "${cmd}". Run "${CLI_NAME} help ${cmd}".`);
    input[hit[0]] = value;
  }
  return { op, input, json, repo, file };
}

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let parsed: Parsed | { help: string };
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if ("help" in parsed) {
    io.out(parsed.help);
    return 0;
  }
  const { op, json, repo, file } = parsed;
  const input = { ...parsed.input };

  const root = findRepoRoot(repo ?? process.cwd());
  setConfig(loadConfig(process.env, root));

  let redact = (t: string) => t;
  try {
    redact = buildPathRedactor(await readEcosystem());
  } catch {
    // a malformed ecosystem.json surfaces below with its own message
  }

  try {
    if (op.params.content && input.content === undefined) {
      if (file) input.content = await readFile(resolve(file), "utf-8");
      else {
        const piped = await io.readStdin();
        if (piped !== null) input.content = piped;
      }
    }
    let valid: Input;
    try {
      valid = validateInput(op, input);
    } catch (err) {
      io.err(`${redact(err instanceof Error ? err.message : String(err))}\nUsage: ${CLI_NAME} ${op.name} ${op.usage}`);
      return 2;
    }
    const bus = await openBus("cli");
    const { result, text } = await op.run(bus, valid);
    io.out(redact(json ? JSON.stringify(result, null, 2) : text));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(redact(err instanceof BridgeError ? message : `Error: ${message}`));
    return 1;
  }
}
