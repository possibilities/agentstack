/**
 * The contract → MCP mapping, whole, in one file.
 *
 * `agentstart/config/agent-contract/MCP.md` is the normative specification and
 * this module implements exactly it: which leaves become tools, how names and
 * input schemas are built, how each constraint maps, how the annotations are
 * derived, what the server's instructions carry, and how a tool call becomes
 * an invocation. Nothing here decides which commands an agent may call — the
 * contract already answered that in `audience`, and a mapper that second-guessed
 * it would have moved the decision back to the consumer.
 *
 * Sibling CLIs carry the same mapping, so it is deliberately dull. The
 * Brain-specific judgments are the annotation facts the contract cannot
 * state and the collapse of a duplicated property name, and both are marked
 * where they appear.
 *
 * Nothing in here imports the MCP SDK: the mapping is a description of tools,
 * and `api.ts` adapts the descriptions to the shared Package API transports.
 */

import * as z from "zod/v4";
import {
  AGENT_CONTRACT,
  type AgentContract,
  type ContractArgument,
  type ContractCommand,
  type ContractConstraint,
  constraintSentence,
} from "./contract.js";

/** The four hints MCP carries. Declared here rather than imported so this file
 * stays SDK-free; the shape is `ToolAnnotations` and is checked structurally. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface AgentTool {
  /** The command's full path joined with `_`, never prefixed with the CLI name:
   * the host already namespaces by server. */
  name: string;
  /** The same path unjoined — the dispatcher needs the segments. */
  path: string[];
  title: string;
  description: string;
  /** Advertised as JSON Schema and used to validate the call. */
  input: z.ZodObject<Record<string, z.ZodType>>;
  annotations: ToolAnnotations;
  /** Exactly the arguments the schema above exposes — the leaf's own plus any
   * `call` global, after collapsing duplicate property names. Held so invoking
   * reads the same set the schema advertised. */
  arguments: ContractArgument[];
  leaf: ContractCommand;
}

// --- Which commands become tools ---

/**
 * Exactly the leaves whose `audience` is `agent`: not groups, which are not
 * invocable, and not `operator` or `internal` — `mcp` itself included.
 *
 * The leaf's own audience decides, never its group's. A group is a help
 * heading; the judgment about who may call a verb is made on the verb, which
 * is why `jobs list` is served while `jobs retry` beside it is not.
 */
function agentLeaves(
  commands: ContractCommand[],
  prefix: string[] = [],
  includeOperator = false,
): { path: string[]; leaf: ContractCommand }[] {
  return commands.flatMap((command) => {
    const path = [...prefix, command.name];
    if (command.subcommands !== undefined)
      return agentLeaves(command.subcommands, path, includeOperator);
    return command.audience === "agent" || (includeOperator && command.audience === "operator") ? [{ path, leaf: command }] : [];
  });
}

// --- Input schema ---

/** `--chunk-id` → `chunk-id`, `source` → `source`. */
function propertyName(name: string): string {
  return name.replace(/^--/, "");
}

/**
 * The arguments a leaf exposes, after collapsing two spellings of one value.
 *
 * AgentStack Brain's `search` and `context` each declare the query twice — as a
 * positional and as `--query` — because at a shell a query beginning with a
 * dash cannot be positional. An MCP caller has no shell and no argv, so the
 * distinction is noise that would collide on the property name `query`. The
 * flag spelling wins: it is the one that can carry any value at all.
 *
 * The rule is general rather than a name check, so a sibling pair added later
 * collapses the same way instead of silently producing two properties whose
 * second overwrites the first.
 */
function collapseDuplicates(argumentList: ContractArgument[]): {
  exposed: ContractArgument[];
  collapsed: Map<string, string[]>;
} {
  const byProperty = new Map<string, ContractArgument[]>();
  for (const argument of argumentList) {
    const property = propertyName(argument.name);
    byProperty.set(property, [...(byProperty.get(property) ?? []), argument]);
  }
  const exposed: ContractArgument[] = [];
  const collapsed = new Map<string, string[]>();
  for (const [property, group] of byProperty) {
    const winner = group.find((a) => a.positional !== true) ?? group[0];
    if (winner === undefined) continue;
    exposed.push(winner);
    if (group.length > 1)
      collapsed.set(
        property,
        group.map((a) => a.name),
      );
  }
  return { exposed, collapsed };
}

/**
 * A leaf's own arguments, plus the globals whose `role` is `call`.
 *
 * Everything else is suppressed: `--json`, `--jsonl`, `--format` and `--quiet`
 * are output shape the server has already fixed, `--db` is which index is being
 * served rather than a per-call choice, and the four meta flags print help
 * instead of running the command. In AgentStack Brain that suppresses all nine
 * globals.
 */
function callArguments(
  contract: AgentContract,
  leaf: ContractCommand,
): ContractArgument[] {
  const globals = contract.global_arguments.filter(
    (argument) => (argument.role ?? "call") === "call",
  );
  return [...(leaf.arguments ?? []), ...globals];
}

/** MCP.md: a `ref` stays a string, and the caller is told a label resolves.
 * AgentStack Brain declares no `ref` argument — its selectors are ids and URIs — but
 * the branch stays so a later one is described rather than silently bare. */
const REF_NOTE =
  "Accepts an id or any unambiguous name; ids are opaque and are not the only way to name a thing.";

/** MCP.md: an `out` path is a destination the command writes, and the caller
 * did not choose the working directory a relative one resolves against. */
const OUT_PATH_NOTE =
  "The command WRITES this path. A relative path resolves against a working directory this caller did not choose, and an existing file is overwritten.";

/** MCP.md: an `in` path is read from that same unchosen working directory, so
 * an out-of-process caller that sends a relative path is guessing. */
const IN_PATH_NOTE =
  "A relative path resolves against a working directory this caller did not choose; send an absolute path.";

/**
 * Said even when the authored description already says it. The mapping has to
 * GUARANTEE the caller is told how a csv argument is spelled; a mapper that
 * first checks whether the prose says it is one that silently stops saying it
 * the day the prose is reworded.
 */
function csvNote(): string {
  return "Every entry is comma-joined into one value when the command is invoked.";
}

function propertyDescription(
  argument: ContractArgument,
  collapsedNames: string[] | undefined,
): string {
  const parts = [argument.description];
  if (argument.format === "ref") parts.push(REF_NOTE);
  if (argument.csv === true) parts.push(csvNote());
  if (argument.format === "path" && argument.direction === "out")
    parts.push(OUT_PATH_NOTE);
  if (argument.format === "path" && argument.direction !== "out")
    parts.push(IN_PATH_NOTE);
  if (collapsedNames !== undefined)
    parts.push(
      `The CLI spells this ${collapsedNames.join(" or ")}; over MCP it is one property.`,
    );
  return parts.join(" ");
}

/**
 * The contract's four scalars, verbatim. `choices` becomes an enum — AgentStack Brain
 * has no non-string choice list, and a numeric one would need its own branch
 * rather than a coercion that quietly changed the type.
 */
function scalar(argument: ContractArgument): z.ZodType {
  if (argument.type === "boolean") return z.boolean();
  if (argument.choices !== undefined)
    return z.enum(argument.choices as [string, ...string[]]);
  if (argument.type === "string") return z.string();
  let numeric = argument.type === "integer" ? z.number().int() : z.number();
  if (argument.minimum !== undefined) numeric = numeric.min(argument.minimum);
  if (argument.maximum !== undefined) numeric = numeric.max(argument.maximum);
  return numeric;
}

function property(
  argument: ContractArgument,
  required: boolean,
  collapsedNames: string[] | undefined,
): z.ZodType {
  // `repeatable` without `csv` is an array of the scalar, invoked by repeating
  // the flag; `repeatable` AND `csv` is also an array, comma-joined into one.
  const base =
    argument.repeatable === true ? z.array(scalar(argument)) : scalar(argument);
  const described = base.describe(
    propertyDescription(argument, collapsedNames),
  );
  // A default makes the property optional in the input schema on its own, which
  // is why it is checked before `required`.
  if (argument.default !== undefined)
    return described.default(argument.default as never);
  return required ? described : z.optional(described);
}

// --- Constraints ---

/**
 * Expressed in the schema where JSON Schema can, and in the description ALWAYS.
 * A schema-only rule is invisible in most host UIs, and a caller that cannot see
 * a rule breaks it.
 *
 * Zod cannot express a cross-field rule, so the schema keywords are injected
 * through its metadata, which the SDK's converter merges into the emitted JSON
 * Schema. They are advisory either way: the command itself is the enforcement,
 * and duplicating its checks here would be the second authorship this contract
 * exists to delete.
 */
interface MappedConstraints {
  keywords: Record<string, unknown>;
  sentences: string[];
  /** Properties a required `one_of` collapsed onto, which are therefore simply
   * required rather than a one-member `oneOf`. */
  required: Set<string>;
}

/** Selector requirements; completeConstraintBranches adds the object shape. */
function eitherOf(members: string[]): { required: string[] }[] {
  return members.map((member) => ({ required: [member] }));
}

/** The constraint's arguments as distinct properties, in declaration order. */
function distinctMembers(constraint: ContractConstraint): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of constraint.arguments) {
    const property = propertyName(name);
    if (seen.has(property)) continue;
    seen.add(property);
    out.push(name);
  }
  return out;
}

function mapConstraints(leaf: ContractCommand): MappedConstraints {
  const keywords: Record<string, unknown> = {};
  const sentences: string[] = [];
  const required = new Set<string>();
  for (const constraint of leaf.constraints ?? []) {
    const names = distinctMembers(constraint);
    const members = names.map(propertyName);
    // A rule whose arguments all collapsed onto one property is no longer a
    // choice: `search` needs the query, however it used to be spelled.
    if (members.length === 1) {
      const only = members[0] as string;
      if (constraint.kind === "one_of" && constraint.required === true) {
        required.add(only);
        sentences.push(
          constraint.description === undefined
            ? `${only} is required.`
            : `${only} is required: ${constraint.description}`,
        );
      }
      continue;
    }
    // Said in the CLI's own words, with the arguments spelled as the properties
    // this schema advertises rather than as flags.
    sentences.push(
      constraintSentence({ ...constraint, arguments: names }, propertyName),
    );
    switch (constraint.kind) {
      case "one_of":
        // Nothing in JSON Schema says "at most one" without `not`, which is
        // legal and unreadable in practice; there the sentence is the whole
        // mapping.
        if (constraint.required === true) keywords["oneOf"] = eitherOf(members);
        break;
      case "at_least_one":
        keywords["anyOf"] = eitherOf(members);
        break;
      case "requires":
        keywords["dependentRequired"] = {
          [members[0] as string]: members.slice(1),
        };
        break;
      case "conflicts":
        // Expressible as `not`/`allOf` and unreadable as either; described only.
        break;
    }
  }
  return { keywords, sentences, required };
}

// --- Annotations ---

/**
 * Verbs that remove or overwrite. MCP.md derives `destructiveHint` from
 * `mutates` plus the verb, and the verb is the one thing it cannot read off a
 * field — so the list is here, once, rather than a hint per command.
 */
const REMOVING_VERBS = new Set([
  "rm",
  "remove",
  "delete",
  "destroy",
  "gc",
  "prune",
  "purge",
  "clear",
]);

/**
 * Full paths whose repeat call is NOT a no-op.
 *
 * AgentStack Brain's admission is idempotent by construction: an equivalent intent
 * comes back `duplicate` with the same job_id rather than queuing a second one,
 * which is exactly what MCP.md calls idempotent. `jobs show --reveal-content`
 * is the exception — every reveal appends a sensitive-inspection audit record,
 * so calling it twice leaves a ledger that calling it once does not.
 */
const APPENDING: ReadonlySet<string> = new Set(["jobs show"]);

/**
 * Full paths that reach the network. Empty on purpose, and it is the whole
 * shape of this CLI: admission performs no network work, and the URL fetching
 * happens later in `worker`, which is operator-audience and not served here.
 */
const NETWORK: ReadonlySet<string> = new Set<string>();

/**
 * The two lists above, exported for the test that pins them against the
 * contract: a list naming a command nobody has is a list that has rotted, and
 * an annotation is the one place where nothing else would notice.
 */
export const ANNOTATION_EXCEPTIONS: {
  appending: ReadonlySet<string>;
  network: ReadonlySet<string>;
} = {
  appending: APPENDING,
  network: NETWORK,
};

function annotations(path: string[], leaf: ContractCommand): ToolAnnotations {
  const full = path.join(" ");
  const writesOut = (leaf.arguments ?? []).some(
    (argument) => argument.format === "path" && argument.direction === "out",
  );
  return {
    readOnlyHint: leaf.mutates === false,
    destructiveHint:
      leaf.mutates === true && (REMOVING_VERBS.has(leaf.name) || writesOut),
    idempotentHint: !APPENDING.has(full),
    openWorldHint: NETWORK.has(full),
  };
}

// --- Description ---

function toolDescription(
  contract: AgentContract,
  path: string[],
  leaf: ContractCommand,
  sentences: string[],
): string {
  const parts: string[] = [];
  // MCP.md: a blocking command says so in the FIRST sentence, because a host
  // with a request timeout has no other way to know. Nothing AgentStack Brain serves
  // spends money or quota; a sibling whose command bills says so in that leaf's
  // own `guidance`, which lands below.
  if (leaf.blocking === true) {
    parts.push(
      "Blocks: with --wait this waits on the worker outside this call and may not return promptly.",
    );
  }
  parts.push(`${leaf.summary}.`);
  // The guidance below quotes CLI invocations; this is what makes them legible.
  parts.push(
    `Invokes the internal \`${path.join(" ")}\` handler in this process.`,
  );
  parts.push(...sentences);
  if (leaf.guidance !== undefined) parts.push(leaf.guidance);
  return parts.join("\n\n");
}

// --- The surface ---

/** Keep union branches independently discoverable without losing field types. */
function completeConstraintBranches(
  input: z.ZodObject<Record<string, z.ZodType>>,
  keywords: Record<string, unknown>,
): Record<string, unknown> {
  const base = z.toJSONSchema(input, { io: "input" });
  const properties = base.properties ?? {};
  const result = { ...keywords };
  for (const kind of ["oneOf", "anyOf"]) {
    const alternatives = keywords[kind];
    if (!Array.isArray(alternatives)) continue;
    result[kind] = alternatives.map((alternative: { required: string[] }) => ({
      type: "object",
      ...(base.additionalProperties === undefined
        ? {}
        : { additionalProperties: base.additionalProperties }),
      required: [
        ...new Set([...(base.required ?? []), ...alternative.required]),
      ],
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [
          name,
          typeof schema === "object" &&
          schema.type === "boolean" &&
          alternative.required.includes(name)
            ? { ...schema, const: true }
            : schema,
        ]),
      ),
    }));
  }
  return result;
}

export function agentTools(
  contract: AgentContract = AGENT_CONTRACT,
  includeOperator = false,
): AgentTool[] {
  return agentLeaves(contract.commands, [], includeOperator).map(({ path, leaf }) => {
    const { exposed, collapsed } = collapseDuplicates(
      callArguments(contract, leaf),
    );
    const { keywords, sentences, required } = mapConstraints(leaf);
    const shape: Record<string, z.ZodType> = {};
    for (const argument of exposed) {
      const name = propertyName(argument.name);
      shape[name] = property(
        argument,
        argument.required === true || required.has(name),
        collapsed.get(name),
      );
    }
    const input = z.object(shape);
    return {
      name: path.join("_"),
      path,
      title: leaf.summary,
      description: toolDescription(contract, path, leaf, sentences),
      input: input.meta(completeConstraintBranches(input, keywords)),
      annotations: annotations(path, leaf),
      arguments: exposed,
      leaf,
    };
  });
}

/**
 * What a caller most reliably gets wrong, said in the contract's own terms.
 *
 * Read from `concepts.model.submission_contract` rather than retyped: the three
 * status words and the wait-timeout guarantee are already authored once there,
 * and a second copy would be the drift this contract exists to end. Every field
 * is optional in the type, so each line is emitted only when the contract
 * actually states it.
 *
 * It is here rather than left to `submit`'s own description because a host
 * shows tool descriptions only once a tool is chosen, and the caller that
 * submits, searches, finds nothing, and concludes the server is broken made
 * that mistake before reading either one.
 */
function submissionParagraph(contract: AgentContract): string {
  const model = (contract.concepts.model ?? {}) as Record<string, unknown>;
  const submission = (model["submission_contract"] ?? {}) as Record<
    string,
    unknown
  >;
  const word = (key: string): string | undefined => {
    const value = submission[key];
    return typeof value === "string" ? value : undefined;
  };
  const lines = [
    "Submission is durable and asynchronous. A tool call that admits an intent",
    "returns as soon as the intent is stored; the worker materializes it later,",
    "so a submitted URL is never searchable immediately and a search that finds",
    "nothing right after a submit is the expected result, not a failure.",
  ];
  const queued = word("new_status");
  const duplicate = word("replay_status");
  if (queued !== undefined && duplicate !== undefined)
    lines.push(
      `Both ${queued} and ${duplicate} are successful acknowledgements — ${duplicate} means an`,
      "equivalent intent was already admitted and names that same job.",
    );
  const indexed = word("indexed_url_status");
  const force = word("indexed_url_force_flag");
  if (indexed !== undefined)
    lines.push(
      `${indexed} is a success too: it names an existing document rather than queuing`,
      force === undefined
        ? "anything."
        : `anything, and \`${force}\` queues rematerialization anyway.`,
    );
  if (submission["wait_timeout_preserves_job"] === true)
    lines.push(
      "Waiting is observation only. A wait that times out is not a failed",
      "submission: the acknowledgement still succeeds, and the durable job",
      "continues toward the same outcome. Poll the ledger instead of resubmitting.",
    );
  return lines.join("\n");
}

/**
 * The server's `instructions`: the contract's `guidance`, then what `concepts`
 * says a caller must know — the envelope, the error codes with their recovery,
 * and `agent_defaults`. This is the half of the contract a tool schema cannot
 * carry, and dropping it ships a surface that works and is used wrongly.
 *
 * The guidance is where the two things a caller most easily gets wrong are
 * already written: that `context` is the one bounded search-and-evidence call
 * to start with, and that admission is durable and asynchronous, so a submitted
 * URL is never searchable immediately. A caller that assumes otherwise submits
 * and searches in the same breath and finds nothing.
 *
 * The exit-code table is left out as a table — there is no process to exit
 * here, and a refusal arrives as a tool error instead — but its one line that
 * is not a synonym for failure is kept in prose. Exit 124 is a wait
 * OBSERVATION timing out while the durable run continues, and collapsing that
 * into a generic failure is how a caller resubmits work that was never lost.
 * No served tool can even produce it (`sources sync`, the only command that
 * does, is operator-audience), and the served `--wait` commands express the
 * same thing as a SUCCESS carrying `wait_status: timeout`. A caller told
 * nothing would read that success as a hang and retry it.
 */
export function serverInstructions(
  contract: AgentContract = AGENT_CONTRACT,
): string {
  const envelope = Object.entries(contract.concepts.output_contract.envelope)
    .map(([field, meaning]) => `  ${field}: ${String(meaning)}`)
    .join("\n");
  const errors = contract.concepts.error_codes
    .map((entry) =>
      entry.recovery === undefined
        ? `  ${entry.code} — ${entry.meaning}`
        : `  ${entry.code} — ${entry.meaning} → ${entry.recovery}`,
    )
    .join("\n");
  const defaults = (contract.concepts.agent_defaults ?? [])
    .map((line) => `  ${line}`)
    .join("\n");
  return `${contract.guidance}

${submissionParagraph(contract)}

Every tool returns ${contract.meta.name}'s own envelope as JSON text:
${envelope}

A refusal comes back as a tool error whose first line is the error code, then
the message, then the recovery when there is one. The recovery line is the
difference between a caller that retries correctly and one that retries
identically, so read it before calling again.

Error codes
${errors}

Opening moves
${defaults}
`;
}

// --- Invoking ---

/**
 * A tool call, as this CLI's own top-level dispatcher takes it.
 *
 * AgentStack Brain's dispatcher is argv-shaped the whole way down: `runParsed` reads
 * a command name and that command's remaining words, and each command parses
 * its own options. There is no per-command handler taking parsed flags to call
 * instead, so the tokens below are BUILT — as an array, never as a shell string
 * and never quoted — and handed to the same in-process dispatcher a terminal
 * invocation reaches. Nothing is spawned.
 */
export interface Invocation {
  command: string;
  commandArgv: string[];
}

function token(argument: ContractArgument, value: unknown): string[] {
  const name = propertyName(argument.name);
  if (Array.isArray(value)) {
    // MCP.md: `repeatable` and `csv` together is one comma-joined value;
    // `repeatable` alone repeats the flag, which this CLI's parser accumulates.
    if (argument.csv === true)
      return [`--${name}=${value.map(String).join(",")}`];
    return value.map((entry) => `--${name}=${String(entry)}`);
  }
  // Booleans are spelled out rather than dropped when false: `--recursive` and
  // `--skip-secrets` default to true, so omitting a false one would silently
  // invert it.
  return [`--${name}=${String(value)}`];
}

/**
 * Tool arguments → the command words the dispatcher reads.
 *
 * The path segments lead, then flags, then positionals after `--` so content
 * beginning with a dash remains data. A
 * flag is always spelled `--name=value`, so a value beginning with a dash or
 * containing a space needs no escaping and cannot be read as the next flag.
 */
export function invocationFor(
  tool: AgentTool,
  args: Record<string, unknown>,
): Invocation {
  const positional: string[] = [];
  const flags: string[] = [];

  for (const argument of tool.arguments) {
    const value = args[propertyName(argument.name)];
    if (value === undefined) continue;
    if (argument.positional === true) {
      positional.push(String(value));
      continue;
    }
    flags.push(...token(argument, value));
  }

  return {
    command: tool.path[0] as string,
    commandArgv: [...tool.path.slice(1), ...flags, ...(positional.length ? ["--", ...positional] : [])],
  };
}
