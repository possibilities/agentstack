import { UsageError } from "./errors.js";

/** Per-command grammar: which flags take a value, which are booleans. */
export interface FlagSpec {
  value: Set<string>;
  bool: Set<string>;
}

export interface ParsedFlags {
  values: Record<string, string>;
  bools: Set<string>;
  positional: string[];
}

/**
 * Strict argv parser: unknown, duplicated, and value-less flags are usage
 * faults rather than silent drops; "--flag=value" and "--flag value" are
 * equivalent spellings; "--" ends flag parsing.
 */
export function parseFlags(argv: string[], spec: FlagSpec): ParsedFlags {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  let flagsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (flagsEnded || !argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--") {
      flagsEnded = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    if (!spec.value.has(flag) && !spec.bool.has(flag)) {
      throw new UsageError(`unknown option "${flag}"`);
    }
    if (seen.has(flag)) {
      throw new UsageError(`option "${flag}" given more than once`);
    }
    seen.add(flag);
    if (spec.bool.has(flag)) {
      if (inline !== undefined) throw new UsageError(`"${flag}" takes no value`);
      bools.add(flag.slice(2));
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`option "${flag}" requires a value`);
      }
      value = next;
      i++;
    }
    values[flag.slice(2)] = value;
  }

  return { values, bools, positional };
}
