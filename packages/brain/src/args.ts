import { CliError } from "./errors.js";
import { brainStateRoot } from "./paths.js";
import { join } from "node:path";
import type { GlobalOptions, OutputFormat } from "./types.js";

export interface ParsedArgv {
  command: string | null;
  commandArgv: string[];
  globals: GlobalOptions;
  showHelp: boolean;
  showVersion: boolean;
  showAgentHelp: boolean;
  showAgentTeaser: boolean;
  usesDefaultDb: boolean;
}

export interface OptionSpec {
  type: "boolean" | "string" | "number";
  default?: unknown;
  multiple?: boolean;
}

export type ParsedOptions = Record<string, unknown> & { _: string[] };

function expandHome(path: string, home: string | undefined): string {
  if (path === "~") return home ?? path;
  if (path.startsWith("~/")) return `${home ?? ""}${path.slice(1)}`;
  return path;
}

function normalizeFormat(value: string | undefined): OutputFormat {
  if (value === undefined) return "human";
  if (value === "human" || value === "json" || value === "jsonl") return value;
  throw new CliError("bad_format", `unknown format '${value}'`, {
    exitCode: 2,
    recovery: "Use one of: human, json, jsonl.",
  });
}

export function parseTopLevel(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedArgv {
  let dbPath = join(brainStateRoot(env), "research.db");
  let usesDefaultDb = true;
  let format: OutputFormat = "human";
  let quiet = false;
  let showHelp = false;
  let showVersion = false;
  let showAgentHelp = false;
  let showAgentTeaser = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--db") {
      const value = argv[++i];
      if (value === undefined)
        throw new CliError("missing_value", "--db requires a path", {
          exitCode: 2,
        });
      dbPath = value;
      usesDefaultDb = false;
      continue;
    }
    if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
      usesDefaultDb = false;
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--jsonl") {
      format = "jsonl";
      continue;
    }
    if (arg === "--format") {
      const value = argv[++i];
      if (value === undefined)
        throw new CliError("missing_value", "--format requires a value", {
          exitCode: 2,
        });
      format = normalizeFormat(value);
      continue;
    }
    if (arg.startsWith("--format=")) {
      format = normalizeFormat(arg.slice("--format=".length));
      continue;
    }
    if (arg === "--quiet" || arg === "-q") {
      quiet = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      showVersion = true;
      continue;
    }
    if (arg === "--agent-help") {
      showAgentHelp = true;
      continue;
    }
    if (arg === "--agent-teaser") {
      showAgentTeaser = true;
      continue;
    }
    rest.push(arg);
  }

  return {
    command: rest[0] ?? null,
    commandArgv: rest.slice(1),
    globals: { dbPath: expandHome(dbPath, env.HOME), format, quiet },
    showHelp,
    showVersion,
    showAgentHelp,
    showAgentTeaser,
    usesDefaultDb,
  };
}

export function parseOptions(
  argv: string[],
  specs: Record<string, OptionSpec>,
): ParsedOptions {
  const out: ParsedOptions = { _: [] };
  for (const [key, spec] of Object.entries(specs)) {
    if (spec.default !== undefined) out[key] = spec.default;
    if (spec.multiple) out[key] = [];
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "-") {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const spec = specs[name];
    if (spec === undefined) {
      throw new CliError("unknown_option", `unknown option --${name}`, {
        exitCode: 2,
      });
    }
    let value: string | boolean;
    if (spec.type === "boolean") {
      value = eq === -1 ? true : parseBoolean(arg.slice(eq + 1), name);
    } else {
      const supplied = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (supplied === undefined) {
        throw new CliError("missing_value", `--${name} requires a value`, {
          exitCode: 2,
        });
      }
      value = supplied;
    }
    const parsed =
      spec.type === "number" ? parseNumber(String(value), name) : value;
    if (spec.multiple) {
      (out[name] as unknown[]).push(parsed);
    } else {
      out[name] = parsed;
    }
  }
  return out;
}

function parseBoolean(value: string, name: string): boolean {
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new CliError(
    "bad_boolean",
    `--${name} expects a boolean, got '${value}'`,
    { exitCode: 2 },
  );
}

function parseNumber(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new CliError(
      "bad_number",
      `--${name} expects a number, got '${value}'`,
      { exitCode: 2 },
    );
  }
  return n;
}

export function optString(
  options: ParsedOptions,
  name: string,
): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function optNumber(
  options: ParsedOptions,
  name: string,
): number | undefined {
  const value = options[name];
  return typeof value === "number" ? value : undefined;
}

export function optBoolean(options: ParsedOptions, name: string): boolean {
  return options[name] === true;
}

export function optStrings(options: ParsedOptions, name: string): string[] {
  const value = options[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
