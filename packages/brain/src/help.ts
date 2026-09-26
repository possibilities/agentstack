/**
 * Every help surface this CLI prints is a render of the agent contract.
 *
 * `--help`, `node packages/brain/dist/src/cli.js help <command>`, `--agent-help`, and `--agent-teaser`
 * used to be four hand-written texts standing beside `guide --json`; the
 * summaries, the flag lists, the defaults, the exit codes, and the read-only
 * command list were each authored twice or more, and nothing compared them.
 * This module holds no prose of its own — only layout. Anything that reads as
 * a fact about the CLI belongs in src/contract.ts.
 */

import {
  AGENT_CONTRACT,
  type ContractArgument,
  type ContractCommand,
  type ContractConstraint,
  commandSpellings,
  constraintSentence,
  findCommand,
  isGroup,
  VERSION,
  walkCommands,
} from "./contract.js";

export { VERSION };

const WIDTH = 78;

function wrap(text: string, indent: string, width = WIDTH): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    // A line the author indented is preformatted — a usage form, a worked
    // example — and reflowing it would destroy the thing it is showing.
    if (/^\s/.test(paragraph)) {
      out.push(indent + paragraph.replace(/\s+$/, ""));
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") {
        line = word;
      } else if (`${line} ${word}`.length + indent.length <= width) {
        line = `${line} ${word}`;
      } else {
        out.push(indent + line);
        line = word;
      }
    }
    if (line !== "") out.push(indent + line);
  }
  return out;
}

function valuePlaceholder(argument: ContractArgument): string {
  if (argument.type === "boolean") return "";
  if (argument.format === "path") return " <path>";
  if (argument.type === "integer" || argument.type === "number") return " <n>";
  return " <value>";
}

/** `--limit <n>` / `--dry-run`, the spelling a caller types. */
function flagSpelling(argument: ContractArgument): string {
  const aliases = argument.aliases?.length
    ? `, ${argument.aliases.join(", ")}`
    : "";
  return `${argument.name}${aliases}${valuePlaceholder(argument)}`;
}

function annotate(argument: ContractArgument): string {
  const notes: string[] = [];
  if (argument.choices !== undefined) {
    notes.push(`one of: ${argument.choices.join(", ")}`);
  }
  if (argument.default !== undefined) {
    notes.push(`default: ${String(argument.default)}`);
  }
  if (argument.csv === true) notes.push("comma-joined, one value");
  if (argument.repeatable === true) notes.push("repeatable");
  if (argument.minimum !== undefined)
    notes.push(`at least ${argument.minimum}`);
  if (argument.maximum !== undefined) notes.push(`at most ${argument.maximum}`);
  if (argument.required === true) notes.push("required");
  if (argument.direction === "out") notes.push("written by this command");
  return notes.length === 0 ? "" : ` (${notes.join("; ")})`;
}

/** A two-column block that degrades to a hanging paragraph when a term is long. */
function definitionList(
  entries: Array<{ term: string; body: string }>,
  indent = "  ",
): string[] {
  if (entries.length === 0) return [];
  const gutter = 2;
  const longest = Math.max(...entries.map((entry) => entry.term.length));
  const column = Math.min(longest, 24);
  const out: string[] = [];
  for (const entry of entries) {
    const bodyIndent = indent + " ".repeat(column + gutter);
    const lines = wrap(entry.body, bodyIndent);
    if (entry.term.length > column) {
      out.push(indent + entry.term);
      out.push(...lines);
    } else {
      const head = indent + entry.term.padEnd(column + gutter);
      out.push(head + (lines[0] ?? "").trimStart());
      out.push(...lines.slice(1));
    }
  }
  return out;
}

function positionalToken(argument: ContractArgument): string {
  return argument.required === true
    ? `<${argument.name}>`
    : `[${argument.name}]`;
}

/** `(--document-id <n> | --chunk-id <n> | --source-uri <value>)` */
function requiredChoiceToken(
  constraint: ContractConstraint,
  args: ContractArgument[],
): string | null {
  if (constraint.kind !== "one_of" || constraint.required !== true) return null;
  const members = constraint.arguments
    .map((name) => args.find((argument) => argument.name === name))
    .filter((argument): argument is ContractArgument => argument !== undefined);
  if (members.length !== constraint.arguments.length) return null;
  return `(${members
    .map((argument) =>
      argument.positional === true
        ? `<${argument.name}>`
        : `${argument.name}${valuePlaceholder(argument)}`,
    )
    .join(" | ")})`;
}

function usageLines(path: string[], command: ContractCommand): string[] {
  if (isGroup(command)) {
    return (command.subcommands ?? []).flatMap((sub) =>
      usageLines([...path, sub.name], sub),
    );
  }
  const args = command.arguments ?? [];
  const constraints = command.constraints ?? [];
  const grouped = new Set(
    constraints
      .filter((constraint) => requiredChoiceToken(constraint, args) !== null)
      .flatMap((constraint) => constraint.arguments),
  );
  const tokens: string[] = ["node packages/brain/dist/src/cli.js", ...path];
  for (const argument of args) {
    if (argument.positional !== true || grouped.has(argument.name)) continue;
    tokens.push(positionalToken(argument));
  }
  for (const constraint of constraints) {
    const token = requiredChoiceToken(constraint, args);
    if (token !== null) tokens.push(token);
  }
  const hasOptions = args.some((argument) => argument.positional !== true);
  if (hasOptions) tokens.push("[options]");
  return [`  ${tokens.join(" ")}`];
}

function optionBlock(command: ContractCommand): string[] {
  const args = command.arguments ?? [];
  const positionals = args.filter((argument) => argument.positional === true);
  const flags = args.filter((argument) => argument.positional !== true);
  const out: string[] = [];
  if (positionals.length > 0) {
    out.push("", "Arguments:");
    out.push(
      ...definitionList(
        positionals.map((argument) => ({
          term: positionalToken(argument),
          body: argument.description + annotate(argument),
        })),
      ),
    );
  }
  if (flags.length > 0) {
    out.push("", "Options:");
    out.push(
      ...definitionList(
        flags.map((argument) => ({
          term: flagSpelling(argument),
          body: argument.description + annotate(argument),
        })),
      ),
    );
  }
  return out;
}

function constraintBlock(command: ContractCommand): string[] {
  const constraints = (command.constraints ?? []).filter(
    (constraint) => constraint.description !== undefined,
  );
  if (constraints.length === 0) return [];
  const out = ["", "Argument rules:"];
  for (const constraint of constraints) {
    const lines = wrap(constraintSentence(constraint), "    ");
    out.push(`  - ${(lines[0] ?? "").trimStart()}`, ...lines.slice(1));
  }
  return out;
}

function stdinBlock(command: ContractCommand): string[] {
  if (command.stdin === undefined) return [];
  const required = command.stdin.required === true ? "required" : "optional";
  return [
    "",
    "Standard input:",
    ...wrap(
      `${command.stdin.accepts} (${required}) — ${command.stdin.description}`,
      "  ",
    ),
  ];
}

function subcommandBlock(command: ContractCommand): string[] {
  if (!isGroup(command)) return [];
  return [
    "",
    "Subcommands:",
    ...definitionList(
      (command.subcommands ?? []).map((sub) => ({
        term: sub.name,
        body: sub.summary,
      })),
    ),
  ];
}

/** `Also spelled: node packages/brain/dist/src/cli.js ingest` — an alias is a name, not a second verb. */
function aliasBlock(path: string[], command: ContractCommand): string[] {
  const aliases = command.aliases ?? [];
  if (aliases.length === 0) return [];
  const prefix = path.slice(0, -1);
  return [
    "",
    "Also spelled:",
    ...aliases.map((alias) => `  node packages/brain/dist/src/cli.js ${[...prefix, alias].join(" ")}`),
  ];
}

function commandHelp(path: string[], command: ContractCommand): string {
  const lines: string[] = [
    `AgentStack Brain ${path.join(" ")} — ${command.summary}`,
    "",
    "Usage:",
    ...usageLines(path, command),
    ...aliasBlock(path, command),
    ...subcommandBlock(command),
    ...optionBlock(command),
    ...constraintBlock(command),
    ...stdinBlock(command),
  ];
  if (command.guidance !== undefined) {
    lines.push("", ...wrap(command.guidance, ""));
  }
  if (isGroup(command)) {
    lines.push(
      "",
      `Per-subcommand help: node packages/brain/dist/src/cli.js help ${path.join(" ")} <subcommand>`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function globalOptionBlock(): string[] {
  return definitionList(
    AGENT_CONTRACT.global_arguments.map((argument) => ({
      term: flagSpelling(argument),
      body: argument.description + annotate(argument),
    })),
  );
}

function agentDefaultsBlock(): string[] {
  const defaults = AGENT_CONTRACT.concepts.agent_defaults ?? [];
  if (defaults.length === 0) return [];
  return [
    "",
    "Agent defaults:",
    ...defaults.flatMap((entry, index) => {
      const lines = wrap(entry, "     ");
      return [
        `  ${index + 1}. ${(lines[0] ?? "").trimStart()}`,
        ...lines.slice(1),
      ];
    }),
  ];
}

function exitCodeBlock(): string[] {
  return [
    "",
    "Exit codes:",
    ...definitionList(
      Object.entries(AGENT_CONTRACT.concepts.output_contract.exit_codes).map(
        ([code, meaning]) => ({ term: code, body: meaning }),
      ),
    ),
  ];
}

function buildTopHelp(): string {
  const lines: string[] = [
    ...wrap(`AgentStack Brain — ${AGENT_CONTRACT.meta.purpose}`, ""),
    "",
    "Usage:",
    "  node packages/brain/dist/src/cli.js [global options] <command> [command options]",
    "",
    "Global options:",
    ...globalOptionBlock(),
    "",
    "Commands:",
    ...definitionList(
      AGENT_CONTRACT.commands.map((command) => ({
        term: commandSpellings(command).join(", "),
        body:
          command.summary +
          (isGroup(command)
            ? ` (${(command.subcommands ?? [])
                .map((sub) => sub.name)
                .join(", ")})`
            : ""),
      })),
    ),
    ...agentDefaultsBlock(),
    "",
    ...wrap(AGENT_CONTRACT.guidance, ""),
    "",
    "Use --help on any command, or `node packages/brain/dist/src/cli.js help <command>`, for its options.",
    "Run `node packages/brain/dist/src/cli.js --agent-help` for the agent runbook.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function buildAgentHelp(): string {
  const nodes = walkCommands();
  const leaves = nodes.filter((node) => !isGroup(node.command));
  const agentLeaves = leaves.filter(
    (node) => node.command.audience === "agent",
  );
  const operatorLeaves = leaves.filter(
    (node) => node.command.audience === "operator",
  );
  const envelope = AGENT_CONTRACT.concepts.output_contract.envelope;
  const lines: string[] = [
    ...wrap(`AgentStack Brain — ${AGENT_CONTRACT.meta.purpose}`, ""),
    "",
    ...wrap(AGENT_CONTRACT.guidance, ""),
    ...agentDefaultsBlock(),
    "",
    "Commands for agents:",
    ...definitionList(
      agentLeaves.map((node) => ({
        term: node.path.join(" "),
        body: `${node.command.summary}${
          node.command.mutates === true ? "" : " [read-only]"
        }`,
      })),
    ),
    "",
    "Operator commands (real, supported, human-driven):",
    ...wrap(operatorLeaves.map((node) => node.path.join(" ")).join(", "), "  "),
    "",
    "JSON envelope:",
    ...definitionList(
      Object.entries(envelope).map(([field, shape]) => ({
        term: field,
        body: String(shape),
      })),
    ),
    ...exitCodeBlock(),
    "",
    ...wrap(
      `Every refusal carries a stable error.code; ${AGENT_CONTRACT.concepts.error_codes.length} of them are enumerated with their meanings and recoveries in the contract.`,
      "",
    ),
    "",
    "Full machine-readable contract: node packages/brain/dist/src/cli.js guide --json",
    "Per-command help: node packages/brain/dist/src/cli.js help <command> or <command> --help",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export const TOP_HELP = buildTopHelp();
export const AGENT_HELP = buildAgentHelp();
export const AGENT_TEASER = AGENT_CONTRACT.meta.purpose;

/**
 * Help for the deepest command the given path matches.
 *
 * The path is whatever survived argument parsing, so it can carry a query or a
 * job id after the command name; descending only while segments keep matching
 * makes `search foo --help` and `jobs show 12 --help` both land somewhere
 * useful instead of falling all the way back to the top.
 */
export function helpFor(path: string | null): string {
  if (path === null) return TOP_HELP;
  const segments = path.trim().split(/\s+/).filter(Boolean);
  const matched: string[] = [];
  for (const segment of segments) {
    // Canonicalized as it descends, so `help ingest` prints submit's help
    // under submit's own name rather than teaching the older spelling back.
    const resolved = findCommand([...matched, segment].join(" "));
    if (resolved === null) break;
    matched.push(resolved.name);
  }
  if (matched.length === 0) return TOP_HELP;
  const command = findCommand(matched.join(" "));
  if (command === null) return TOP_HELP;
  return commandHelp(matched, command);
}
