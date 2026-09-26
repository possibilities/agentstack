/**
 * AgentStack Brain's internal operator contract. The Package API derives its
 * input schemas from these command arguments; shared transports own serving.
 *
 * This module is the single authorship of what this CLI is and what it
 * accepts. `guide --json` emits it verbatim; `--help`, `--agent-help`, and
 * `--agent-teaser` are rendered from it (see help.ts); the dispatcher takes
 * its command table from it (see dispatch.ts). Nothing here may be restated
 * in prose elsewhere in this repository — a second copy is exactly the drift
 * this contract exists to end.
 *
 * The normative schema lives at
 * `~/code/agentstart/config/agent-contract/schema.json` and is executed by
 * `~/code/agentstart/scripts/validate-agent-contract.ts`;
 * `test/agent-contract.test.ts` is this repository's own conformance gate.
 */

export const VERSION = "0.2.0";

export type Audience = "agent" | "operator" | "internal";

export interface ContractArgument {
  name: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  format?: "path" | "url" | "duration" | "ref" | "json";
  direction?: "in" | "out";
  required?: boolean;
  positional?: boolean;
  repeatable?: boolean;
  choices?: string[];
  default?: unknown;
  aliases?: string[];
  /** The flag takes one comma-joined string of values. Composes with
   * `repeatable`; when set, `format` describes the ELEMENT. */
  csv?: boolean;
  /** Inclusive bounds for an integer or number argument, stated once here
   * rather than only in prose the renderer cannot act on. */
  minimum?: number;
  maximum?: number;
  /** What kind of knob this is. A consumer building a call surface exposes
   * only `call`: every global here is output shape, store selection, or meta
   * — things the caller has already fixed rather than parameters a model
   * should be asked to choose. */
  role?: "call" | "output-format" | "store-selection" | "meta";
}

export interface ContractConstraint {
  kind: "one_of" | "at_least_one" | "conflicts" | "requires";
  arguments: string[];
  required?: boolean;
  description?: string;
}

export interface ContractStdin {
  accepts: "text" | "json";
  required?: boolean;
  description: string;
}

export interface ContractCommand {
  name: string;
  summary: string;
  audience: Audience;
  mutates?: boolean;
  guidance?: string;
  arguments?: ContractArgument[];
  subcommands?: ContractCommand[];
  stdin?: ContractStdin;
  constraints?: ContractConstraint[];
  /** The command waits on something outside itself and may not return
   * promptly. A caller with a request timeout needs to know before it calls,
   * not after it hangs. */
  blocking?: boolean;
  /** Other names this exact command answers to. An alias is a spelling, not a
   * second verb: it is dispatched, helped, and documented as this command, and
   * a consumer building a call surface offers the canonical name only. */
  aliases?: string[];
  /** Present when the command still works but should not be reached for; the
   * value says what to use instead. */
  deprecated?: string;
}

export interface AgentContract {
  contract_version: 1;
  meta: {
    name: string;
    version: string;
    purpose: string;
    audience: "agent" | "operator";
  };
  guidance: string;
  concepts: {
    model?: Record<string, unknown>;
    output_contract: {
      envelope: Record<string, unknown>;
      exit_codes: Record<string, string>;
      [key: string]: unknown;
    };
    error_codes: Array<{ code: string; meaning: string; recovery?: string }>;
    read_only_commands?: string[];
    agent_defaults?: string[];
    [key: string]: unknown;
  };
  global_arguments: ContractArgument[];
  commands: ContractCommand[];
}

/** Filters shared verbatim by `search` and `context`. */
function discoveryFilters(): ContractArgument[] {
  return [
    {
      name: "--tag",
      type: "string",
      description: "Require an exact document tag.",
    },
    {
      name: "--source-type",
      type: "string",
      description: "Require a legacy document source_type.",
    },
    {
      name: "--content-kind",
      type: "string",
      description:
        "Require the parser-derived content kind. Null on legacy or unclassified documents, which such a filter therefore excludes.",
      choices: ["post", "thread", "article"],
    },
    {
      name: "--collection",
      type: "string",
      description: "Require exact collection membership by slug.",
    },
    {
      name: "--source",
      type: "string",
      description:
        "Require an exact source identifier, or source_type:identifier.",
    },
    {
      name: "--resource-kind",
      type: "string",
      description: "Require an exact resource kind.",
    },
    {
      name: "--sensitivity",
      type: "string",
      description: "Require an effective sensitivity policy.",
      choices: ["public", "normal", "sensitive", "private"],
    },
    {
      name: "--date",
      type: "string",
      description: "Require the document update date (yyyy-mm-dd).",
    },
    {
      name: "--date-from",
      type: "string",
      description: "Require updates on or after a date or ISO timestamp.",
    },
    {
      name: "--date-to",
      type: "string",
      description: "Require updates through a date or ISO timestamp.",
    },
    {
      name: "--local-path",
      type: "string",
      description: "Require an exact local document path or resource alias.",
    },
  ];
}

/** The `submit` argument surface, shared verbatim by its `ingest` alias. */
function admissionArguments(): ContractArgument[] {
  return [
    {
      name: "source",
      type: "string",
      description:
        "The URL, file, directory, or literal text to admit. Exactly one.",
      positional: true,
      required: true,
    },
    {
      name: "--intent-version",
      type: "integer",
      description: "Versioned intent contract.",
      minimum: 1,
      default: 1,
    },
    {
      name: "--kind",
      type: "string",
      description: "How to interpret the source.",
      choices: ["auto", "url", "file", "directory", "text"],
      default: "auto",
    },
    {
      name: "--source-type",
      type: "string",
      description:
        "Cutover alias for --kind. Giving both is refused unless they agree.",
      choices: ["auto", "url", "file", "directory", "text"],
      default: "auto",
    },
    {
      name: "--ingress",
      type: "string",
      description: "Submitting actor or interface, recorded on the intent.",
      default: "cli",
    },
    {
      name: "--collection",
      type: "string",
      description: "Request collection membership by slug.",
      repeatable: true,
    },
    {
      name: "--idempotency-key",
      type: "string",
      description:
        "Explicit replay identity. Reusing one for a different intent is refused as idempotency_conflict.",
    },
    { name: "--title", type: "string", description: "Requested title." },
    {
      name: "--tag",
      type: "string",
      description: "Add one tag.",
      repeatable: true,
    },
    {
      name: "--tags",
      type: "string",
      description: "Add comma- or hash-separated tags.",
      repeatable: true,
      csv: true,
    },
    { name: "--notes", type: "string", description: "Store requested notes." },
    {
      name: "--recursive",
      type: "boolean",
      description:
        "Recurse through directories. Pass --recursive=false to disable.",
      default: true,
    },
    {
      name: "--max-files",
      type: "integer",
      description: "Directory snapshot cap (max 5000).",
      minimum: 1,
      maximum: 5000,
      default: 300,
    },
    {
      name: "--max-bytes",
      type: "integer",
      description: "Text or per-file snapshot cap.",
      minimum: 1,
      default: 5000000,
    },
    {
      name: "--force",
      type: "boolean",
      description:
        "Queue rematerialization even when the URL is already indexed.",
      default: false,
    },
    {
      name: "--skip-secrets",
      type: "boolean",
      description:
        "Skip sensitive files and path components. Pass --skip-secrets=false to disable.",
      default: true,
    },
    {
      name: "--wait",
      type: "boolean",
      description:
        "Observe the admitted job without bypassing the worker. A timeout leaves the job queued and recoverable.",
      default: false,
    },
    {
      name: "--wait-timeout-ms",
      type: "integer",
      description:
        "Stop observing after this duration. A timeout is not a failed submission: the acknowledgement still returns ok with wait_status timeout, and the queued job continues.",
      minimum: 0,
      default: 30000,
    },
  ];
}

const ADMISSION_GUIDANCE = `A new intent exits 0 with status queued. An equivalent intent exits 0 with
status duplicate and the same job_id. A URL whose conservative resource
identity already carries a materialized document exits 0 with status
already_indexed and its document_id instead of queuing; pass --force to queue
rematerialization anyway. Treat queued, duplicate, and already_indexed as
successful durable acknowledgements.

Local bytes are snapshotted into the Artifact store before acknowledgement.
URL admission performs no network work: extraction happens later in the
worker, through Agentscrape, so a submitted URL is never searchable
immediately.`;

export const AGENT_CONTRACT: AgentContract = {
  contract_version: 1,
  meta: {
    name: "AgentStack Brain",
    version: VERSION,
    purpose:
      "Search, retrieve, and durably ingest a local research index: FTS search with citations, bounded context, a durable submission ledger, and recurring sources.",
    audience: "agent",
  },
  guidance: `AgentStack Brain is the sole durable ingestion authority and the reader/writer for
this machine's local research index. Reach for it before any web search or
paid research call: the answer is often already indexed here.

Reading is safe at any time. Prefer \`context "query" --json\` for one bounded
search-and-evidence call; use \`search "query" --json\` when you want to choose
among ranked hits, then fetch the chosen evidence with
\`get --chunk-id ID --json\` (or --document-id / --source-uri). When discovery
is poor, inspect stats, tags, and sources and retry alternate terms before
concluding the index has nothing. Cite document_id, chunk_id when present,
title, source_uri, and relation provenance when it matters.

Writing goes through one door. \`submit\` is the durable admission boundary for
every text, file, directory, or URL intent, and writes no document directly;
\`ingest\` is an older spelling of it. Admission is durable and
offline, so never expect a submitted URL to be searchable immediately —
\`worker\` leases the job later and delegates all URL extraction and network
policy to Agentscrape. AgentStack Brain owns durable admission, the ingestion
ledger, Artifact snapshots, and index writes; Agentscrape owns URL fetching,
browser and session behavior, and extraction.

The ledger is content-safe by default. \`jobs list\`, \`jobs run\`, and
\`jobs stats\` never echo durable intent, raw URLs, Artifact bodies, or query
values. An ordinary \`jobs show\` adds bounded, sanitized failure summaries
with URLs redacted so a stranded job can be diagnosed without database access,
but does not reveal the submitted content. \`jobs show
--reveal-content\` reads Artifact bodies and appends a sensitive-inspection
audit record — pass it only when the body is genuinely required. Retry,
cancel, and exclude are explicit operator acts that append transitions and
preserve every attempt.

The Package API uses <AGENTSTACK_STATE_DIR>/brain/research.db, defaulting to
~/.local/state/agentstack/brain/research.db. The internal operator dispatcher
also accepts an explicit --db path. Read commands open SQLite with a
structurally read-only connection and never initialize or migrate it.

The Package API publishes its operation schemas through AgentStack discovery.
For internal operator command help, run
\`node packages/brain/dist/src/cli.js help <command>\` from the workspace root.`,
  concepts: {
    model: {
      ownership: {
        brain:
          "Durable admission, ingestion jobs and attempts, Artifact storage, index schema, search, retrieval, context, and deletion.",
        agentscrape:
          "All URL fetching, browser and session behavior, backend hardening, and extraction, invoked by the Brain ingestion worker.",
        agentbot: "Human-facing saved-link ingress.",
        boundary:
          "Every public ingestion intent is durable before materialization. Admission performs no network work, and URL workers delegate extraction to Agentscrape without direct HTTP fallback.",
        decision_record:
           "docs/adr/0059-isolated-brain-and-platform-clients.md, docs/brain-maintenance.md",
        glossary: "CONTEXT.md",
      },
      default_db: "~/.local/state/agentstack/brain/research.db",
      source_types: {
        x: ["tweet", "tweet_article"],
        generic: ["scraped_url", "text", "file", "url", "url_text", "url_pdf"],
        note: "X identities canonicalize to x.com/i/status/ID and x.com/i/article/ID.",
      },
      content_classification: {
        field: "content_kind",
        values: ["post", "thread", "article"],
        item_count_field: "content_item_count",
        filter: "--content-kind",
        authority:
          "Parser-derived metadata persisted independently from URL/source identity; null means legacy or not yet classified.",
      },
      submission_contract: {
        version: 1,
        new_status: "queued",
        replay_status: "duplicate",
        indexed_url_status: "already_indexed",
        indexed_url_force_flag: "--force",
        success_exit: 0,
        wait_timeout_preserves_job: true,
      },
      citation_fields: ["document_id", "chunk_id", "source_uri", "title"],
      document_relations: {
        outbound_links:
          "Links discovered from the selected document to targets or unresolved URLs.",
        inbound_links:
          "Links whose to_document_id points at the selected document.",
        relation_fields: [
          "id",
          "from_document_id",
          "to_document_id",
          "relation_type",
          "discovered_url",
          "resolved_url",
          "status",
          "error",
          "created_at",
          "updated_at",
        ],
      },
      safety: {
        read_connections:
          "Read commands open Node SQLite with the readOnly option and never initialize or migrate.",
        writes:
          "Submit and its ingest alias write only durable jobs and required Artifact snapshots; materialization is restricted to the fenced worker path. Operator transitions and explicit content reveal are audited.",
        directories:
          "Traversal streams entries, caps at 20000 entries / 10000 supported candidates, and skips sensitive path components by default.",
        deletion: "Requires exactly one selector and literal --confirm delete.",
        no_raw_sql: true,
        owns_durable_ingestion_ledger: true,
        no_browser_or_network_implementation: true,
      },
    },
    output_contract: {
      envelope: {
        schema_version: "number",
        ok: "boolean",
        command: "string",
        data: "command-specific payload on success",
        error: "{code,message,recovery?} on failure",
        meta: "{db_path,read_only,generated_at} on success",
      },
      exit_codes: {
        "0": "success",
        "1": "runtime, extraction, indexing, not-found, or database failure",
        "2": "argument or pre-admission validation error",
        "124":
          "source-sync wait observation timeout; the durable Run continues unless separately cancelled",
      },
    },
    error_codes: [
      {
        code: "unknown_command",
        meaning: "The first argument is not a command this CLI dispatches.",
        recovery: "Run `node packages/brain/dist/src/cli.js guide --json` for the command list.",
      },
      {
        code: "unknown_option",
        meaning: "A flag the command does not accept was given.",
      },
      {
        code: "unknown_subcommand",
        meaning: "A group was given a subcommand it does not define.",
      },
      {
        code: "unimplemented_command",
        meaning: "A declared command reached the dispatcher with no handler.",
        recovery: "Report this; it is a defect rather than a usage fault.",
      },
      {
        code: "unexpected_args",
        meaning:
          "Positional arguments were given to a command that takes none.",
      },
      {
        code: "unexpected_option",
        meaning: "A flag was combined with a subcommand that refuses it.",
      },
      {
        code: "missing_value",
        meaning: "A value-taking flag was given no value.",
      },
      {
        code: "bad_boolean",
        meaning: "A boolean flag was given a non-boolean value.",
      },
      {
        code: "bad_number",
        meaning: "A numeric flag was given a non-numeric value.",
      },
      {
        code: "bad_integer",
        meaning: "A numeric flag needs an integer, or a positive one.",
      },
      {
        code: "bad_format",
        meaning:
          "--format was given something other than human, json, or jsonl.",
      },
      { code: "bad_mode", meaning: "search --mode was not any, all, or raw." },
      {
        code: "bad_limit",
        meaning: "A --limit is out of its supported range.",
      },
      {
        code: "bad_offset",
        meaning: "A --offset is negative or not an integer.",
      },
      {
        code: "bad_char_limit",
        meaning: "get --char-limit is below the supported minimum.",
      },
      {
        code: "bad_max_chars",
        meaning: "context --max-chars is outside 500..50000.",
      },
      {
        code: "empty_query",
        meaning: "A search or context call carried no query text.",
      },
      { code: "bad_filter", meaning: "A discovery filter value is malformed." },
      {
        code: "bad_date",
        meaning: "A date filter is not a date or ISO timestamp.",
      },
      {
        code: "bad_content_kind",
        meaning: "--content-kind was not post, thread, or article.",
      },
      {
        code: "bad_sensitivity",
        meaning: "--sensitivity was not a supported policy.",
      },
      {
        code: "bad_selector",
        meaning: "A command needing exactly one selector got zero or several.",
        recovery: "Pass exactly one of the selectors the command declares.",
      },
      {
        code: "missing_selector",
        meaning: "A retrieval call carried no selector at all.",
      },
      {
        code: "not_found",
        meaning: "The selected document, chunk, or endpoint does not exist.",
      },
      {
        code: "confirmation_required",
        meaning:
          "delete was called without the literal token --confirm delete.",
      },
      {
        code: "db_not_found",
        meaning: "No research database exists at the resolved path.",
        recovery: "Use the Brain Package API; internal operators may pass --db PATH or set AGENTSTACK_STATE_DIR.",
      },
      {
        code: "db_location_conflict",
        meaning:
          "The default database location is occupied by something that is not a usable database.",
      },
      {
        code: "bad_schema_version",
        meaning: "The database records a malformed schema version.",
      },
      {
        code: "unsupported_schema_version",
        meaning:
          "The database schema is newer or older than this binary supports.",
        recovery: "Upgrade AgentStack, or point --db at a compatible database.",
      },
      {
        code: "bad_source",
        meaning:
          "submit or ingest got no source, an empty one, or an invalid URL.",
      },
      {
        code: "bad_source_type",
        meaning: "--kind and --source-type disagree, or name an unknown kind.",
      },
      {
        code: "idempotency_conflict",
        meaning:
          "An explicit idempotency key was reused for a different intent.",
        recovery: "Use a fresh key, or resubmit the identical intent.",
      },
      {
        code: "invalid_intent",
        meaning: "A stored intent failed its versioned contract.",
      },
      {
        code: "bad_intent",
        meaning: "An intent payload is malformed at the store boundary.",
      },
      {
        code: "bad_jobs_command",
        meaning: "jobs was given no subcommand or an unknown one.",
      },
      {
        code: "bad_job_id",
        meaning: "A jobs subcommand needs exactly one positive job id.",
      },
      {
        code: "bad_job_state",
        meaning: "jobs list --state named an unknown state.",
      },
      { code: "job_not_found", meaning: "No job carries that id." },
      {
        code: "bad_exclude",
        meaning: "jobs exclude was called without --reason.",
      },
      {
        code: "illegal_transition",
        meaning:
          "The requested ledger transition is not legal from the job's state.",
      },
      { code: "attempt_not_found", meaning: "No attempt carries that id." },
      {
        code: "bad_claim",
        meaning: "A worker claim is malformed or no longer valid.",
      },
      {
        code: "bad_audit",
        meaning: "An audit record is malformed at the store boundary.",
      },
      {
        code: "bad_run_id",
        meaning: "A --run or Run positional is not a positive integer.",
      },
      { code: "run_not_found", meaning: "No Run carries that id." },
      {
        code: "run_not_executable",
        meaning: "The Run is not in a state that can execute.",
      },
      {
        code: "run_not_operator_controlled",
        meaning:
          "The Run is an ordinary queue Run, not an operator-controlled one.",
      },
      {
        code: "run_not_quiescent",
        meaning: "Work is still in flight on the Run.",
      },
      {
        code: "run_policy_immutable",
        meaning: "A Run's authorization policy cannot be changed once bound.",
      },
      {
        code: "invalid_run_policy",
        meaning: "The requested Run policy is not a legal policy.",
      },
      {
        code: "fanout_run_mismatch",
        meaning: "A fanned-out job does not belong to the Run that claims it.",
      },
      {
        code: "incomplete_run_scope",
        meaning:
          "A scoped worker needs --run, --authorization-digest, and --allowed-kind together.",
      },
      {
        code: "scoped_worker_requires_once",
        meaning: "A scoped worker must be run with --once.",
      },
      {
        code: "bad_run_scope",
        meaning: "A scope digest or allowed kind is malformed.",
      },
      {
        code: "run_scope_mismatch",
        meaning:
          "The declared scope does not match the Run's persisted authorization.",
      },
      {
        code: "run_scope_cardinality_mismatch",
        meaning:
          "The Run carries a different number of authorized jobs than the scope allows.",
      },
      {
        code: "run_scope_disallowed_runnable",
        meaning:
          "The Run holds runnable work of a kind the scope does not authorize.",
      },
      {
        code: "run_scope_intent_mismatch",
        meaning: "A claimed job's intent is not the one the scope authorized.",
      },
      {
        code: "run_scope_fenced",
        meaning: "Another execution lease holds this Run.",
      },
      {
        code: "offline_scope_external_kind",
        meaning:
          "An offline recovery scope was asked to claim a network-bearing job.",
      },
      {
        code: "online_scope_policy_mismatch",
        meaning: "The online recovery scope does not match its Run's policy.",
      },
      {
        code: "recovery_offline_scope_mismatch",
        meaning:
          "The offline recovery scope does not match its frozen generation.",
      },
      {
        code: "recovery_online_scope_mismatch",
        meaning:
          "The online recovery scope does not match its frozen generation.",
      },
      {
        code: "bad_recovery_command",
        meaning: "recovery was given something other than import or online.",
      },
      {
        code: "bad_recovery_manifest",
        meaning:
          "recovery import needs exactly one frozen generation descriptor.",
      },
      {
        code: "bad_recovery_authorization",
        meaning: "--authorize-offline cannot be combined with --dry-run.",
      },
      {
        code: "incomplete_recovery_online_authorization",
        meaning:
          "recovery online needs the generation, linked offline Run, verified snapshot, and all three digests.",
      },
      {
        code: "invalid_digest",
        meaning: "A digest is not a lowercase SHA-256 hex string.",
      },
      {
        code: "snapshot_mismatch",
        meaning: "The pinned snapshot does not hash to the declared digest.",
      },
      {
        code: "bad_backup_command",
        meaning: "backup was given something other than create or verify.",
      },
      {
        code: "bad_backup_path",
        meaning: "backup create or verify needs exactly one backup path.",
      },
      {
        code: "backup_exists",
        meaning:
          "A backup already exists at that path; publication never replaces one.",
      },
      {
        code: "backup_invalid_schema",
        meaning: "The snapshot's schema failed verification.",
      },
      {
        code: "backup_manifest_invalid",
        meaning: "The backup manifest is malformed.",
      },
      {
        code: "backup_invalid_artifact_reference",
        meaning: "The manifest references an Artifact the store cannot supply.",
      },
      {
        code: "backup_artifacts_unavailable",
        meaning: "The declared Artifact root is missing or unreadable.",
      },
      { code: "bad_artifact", meaning: "An Artifact payload is malformed." },
      {
        code: "bad_artifact_reference",
        meaning: "An Artifact reference is malformed.",
      },
      {
        code: "artifact_not_found",
        meaning: "No Artifact carries that digest.",
      },
      {
        code: "artifact_not_text",
        meaning: "The Artifact is not text and cannot be revealed as such.",
      },
      {
        code: "artifact_not_normalized",
        meaning: "The Artifact bytes are not in normalized form.",
      },
      {
        code: "artifact_metadata_conflict",
        meaning: "Two registrations disagree about one Artifact's metadata.",
      },
      {
        code: "resource_not_found",
        meaning: "No Resource carries that identity.",
      },
      {
        code: "resource_identity_conflict",
        meaning: "Two Resources claim the same conservative identity.",
      },
      {
        code: "resource_update_failed",
        meaning: "A Resource write did not apply.",
      },
      {
        code: "bad_sources_command",
        meaning: "sources was given an unknown subcommand.",
      },
      {
        code: "bad_source_id",
        meaning: "A sources subcommand needs exactly one stable source ID.",
      },
      {
        code: "bad_source_sync",
        meaning:
          "sources sync was given neither a source ID nor --due, or an illegal wait combination.",
      },
      {
        code: "bad_source_limit",
        meaning: "A source window or limit is out of range.",
      },
      {
        code: "bad_source_state",
        meaning: "A source record carries an unknown state.",
      },
      {
        code: "bad_source_actor",
        meaning: "A source audit actor is malformed.",
      },
      {
        code: "bad_source_reason",
        meaning: "A source audit reason is malformed.",
      },
      {
        code: "bad_source_counts",
        meaning: "A source Run reported inconsistent counts.",
      },
      {
        code: "bad_source_warnings",
        meaning: "A source Run reported malformed warnings.",
      },
      {
        code: "bad_source_observation",
        meaning: "A discovered observation is malformed.",
      },
      {
        code: "bad_source_outcome",
        meaning: "A source Run reported an unknown outcome.",
      },
      {
        code: "source_not_found",
        meaning: "No source carries that stable ID.",
      },
      {
        code: "source_definition_not_found",
        meaning: "The source has no stored definition version.",
      },
      {
        code: "source_identity_mismatch",
        meaning: "A manifest entry changes a source's kind or identity.",
      },
      {
        code: "source_version_conflict",
        meaning: "Source content changed without raising its version.",
      },
      {
        code: "duplicate_source_id",
        meaning: "A manifest declares one source ID twice.",
      },
      {
        code: "invalid_source_schedule",
        meaning: "A source schedule is not a legal schedule.",
      },
      {
        code: "invalid_source_state",
        meaning: "A source transition is not legal from its current state.",
      },
      {
        code: "unsupported_source_manifest_version",
        meaning: "The manifest version is newer than this binary supports.",
      },
      {
        code: "source_run_not_found",
        meaning: "No source Run carries that id.",
      },
      {
        code: "source_run_not_startable",
        meaning: "The source Run cannot be started from its current state.",
      },
      {
        code: "source_run_terminal",
        meaning: "The source Run has already finished.",
      },
      {
        code: "source_window_too_large",
        meaning: "The requested discovery window exceeds the source's bound.",
      },
      {
        code: "unsafe_checkpoint",
        meaning:
          "A checkpoint would advance past observations that were neither admitted nor suppressed.",
      },
      {
        code: "share_token_missing",
        meaning: "No share token exists at the resolved path.",
      },
      {
        code: "share_token_invalid",
        meaning: "The share token file is malformed.",
      },
      {
        code: "share_bind_failed",
        meaning: "The share ingress could not bind the requested address.",
      },
      {
        code: "unexpected_error",
        meaning:
          "An error escaped without a contract code; the message carries the detail.",
        recovery: "Report it. A code-less failure is a defect.",
      },
    ],
    read_only_commands: [
      "stats",
      "search",
      "get",
      "context",
      "tags",
      "jobs list",
      "jobs run",
      "jobs stats",
      "backup verify",
      "sources list",
      "sources show",
      "sources status",
      "guide",
      "prompt",
      "help",
    ],
    agent_defaults: [
      "Start with: node packages/brain/dist/src/cli.js guide --json",
      'Search before answering from memory: node packages/brain/dist/src/cli.js search "query" --json',
      "Fetch selected evidence: node packages/brain/dist/src/cli.js get --chunk-id ID --json (or --document-id / --source-uri)",
      "Cite document_id, chunk_id when present, title, source_uri, and relation provenance when relevant.",
    ],
  },
  global_arguments: [
    {
      name: "--db",
      type: "string",
      description:
        "Internal operator database path. The Package API fixes its database under AGENTSTACK_STATE_DIR/brain and does not accept a per-operation override.",
      format: "path",
      direction: "in",
      role: "store-selection",
    },
    {
      name: "--json",
      type: "boolean",
      description: "Emit the stable JSON envelope. Preferred for agents.",
      role: "output-format",
    },
    {
      name: "--jsonl",
      type: "boolean",
      description:
        "Emit newline-delimited records where supported; currently most useful for search.",
      role: "output-format",
    },
    {
      name: "--format",
      type: "string",
      description: "Output format, equivalent to --json / --jsonl.",
      choices: ["human", "json", "jsonl"],
      default: "human",
      role: "output-format",
    },
    {
      name: "--quiet",
      type: "boolean",
      description: "Suppress non-essential human output.",
      aliases: ["-q"],
      role: "output-format",
    },
    {
      name: "--help",
      type: "boolean",
      description: "Show help for the CLI or the named command.",
      aliases: ["-h"],
      role: "meta",
    },
    {
      name: "--version",
      type: "boolean",
      description: "Show the version.",
      aliases: ["-V"],
      role: "meta",
    },
    {
      name: "--agent-help",
      type: "boolean",
      description:
        "Show the agent runbook. This contract is the full machine card.",
      role: "meta",
    },
    {
      name: "--agent-teaser",
      type: "boolean",
      description: "Show a one-line capability summary.",
      role: "meta",
    },
  ],
  commands: [
    {
      name: "stats",
      summary:
        "Summarize DB size, counts, source types, tags, relations, and recent documents",
      audience: "agent",
      mutates: false,
      guidance:
        "Inventory to consult when discovery is poor, before concluding the index has nothing on a subject.",
      arguments: [
        {
          name: "--top-tags",
          type: "integer",
          description: "Number of top tags to include (max 500).",
          minimum: 1,
          maximum: 500,
          default: 25,
        },
        {
          name: "--recent",
          type: "integer",
          description: "Number of recent documents to include (max 50).",
          minimum: 1,
          maximum: 50,
          default: 5,
        },
      ],
    },
    {
      name: "search",
      summary: "Search chunks with SQLite FTS5 and return ranked snippets",
      audience: "agent",
      mutates: false,
      guidance: `Query modes: any tokenizes and joins terms with OR and is the best first
pass; all requires every term or phrase; raw passes SQLite FTS5 MATCH syntax
through unchanged.

data.results carry parser-derived content_kind and content_item_count
alongside ids, source, snippet, tags, score, and offsets. Follow a hit with
\`get --chunk-id ID\` for the full evidence.

Pass the query with --query when it begins with a dash; otherwise the
positional words are joined into the query.`,
      constraints: [
        {
          kind: "one_of",
          arguments: ["query", "--query"],
          required: true,
          description: "The query text, positionally or as a flag.",
        },
      ],
      arguments: [
        {
          name: "query",
          type: "string",
          description: "Query words, joined with spaces.",
          positional: true,
        },
        {
          name: "--query",
          type: "string",
          description: "Query text; use this when the query begins with '-'.",
        },
        {
          name: "--mode",
          type: "string",
          description: "How query terms are combined.",
          choices: ["any", "all", "raw"],
          default: "any",
        },
        {
          name: "--limit",
          type: "integer",
          description: "Results per page (max 50).",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
        {
          name: "--offset",
          type: "integer",
          description: "Page offset.",
          minimum: 0,
          default: 0,
        },
        ...discoveryFilters(),
      ],
    },
    {
      name: "get",
      summary: "Retrieve a full document by id/source URI or a chunk by id",
      audience: "agent",
      mutates: false,
      guidance: `Document results include outbound_links and inbound_links relation arrays
when document_links exists. Each relation carries id, from_document_id,
to_document_id, relation_type, discovered_url, resolved_url, status, error,
created_at, and updated_at.

--char-limit and --full apply to document retrieval only; a chunk is returned
whole.`,
      constraints: [
        {
          kind: "one_of",
          arguments: ["--document-id", "--chunk-id", "--source-uri"],
          required: true,
          description: "Exactly one selector. Zero or two is refused.",
        },
      ],
      arguments: [
        {
          name: "--document-id",
          type: "integer",
          description: "Retrieve a document by document id.",
        },
        {
          name: "--chunk-id",
          type: "integer",
          description: "Retrieve a single chunk by chunk id.",
        },
        {
          name: "--source-uri",
          type: "string",
          description:
            "Retrieve the most recently updated document with this source URI.",
        },
        {
          name: "--char-limit",
          type: "integer",
          description:
            "Limit document content with head/tail truncation (min 500).",
          minimum: 500,
          default: 20000,
        },
        {
          name: "--full",
          type: "boolean",
          description: "Return full document content.",
          default: false,
        },
      ],
    },
    {
      name: "context",
      summary: "Return bounded citation-ready context for a query",
      audience: "agent",
      mutates: false,
      guidance: `One bounded search-and-evidence call, and the usual first move for a
shell-enabled agent.

data.hits carry resource provenance, typed relation summaries, citation,
bounded chunk content, offsets, tags, score, and per-hit truncation. Linked
resource content is never concatenated into a hit.`,
      constraints: [
        {
          kind: "one_of",
          arguments: ["query", "--query"],
          required: true,
          description: "The query text, positionally or as a flag.",
        },
      ],
      arguments: [
        {
          name: "query",
          type: "string",
          description: "Query words, joined with spaces.",
          positional: true,
        },
        {
          name: "--query",
          type: "string",
          description: "Query text instead of positional words.",
        },
        {
          name: "--limit",
          type: "integer",
          description: "Maximum resource hits (max 20).",
          minimum: 1,
          maximum: 20,
          default: 6,
        },
        {
          name: "--max-chars",
          type: "integer",
          description: "Total chunk-content budget (500..50000).",
          minimum: 500,
          maximum: 50000,
          default: 12000,
        },
        ...discoveryFilters(),
      ],
    },
    {
      name: "submit",
      summary: "Durably queue a text, file, directory, or URL intent",
      audience: "agent",
      mutates: true,
      blocking: true,
      aliases: ["ingest"],
      guidance: `\`ingest\` is an older spelling of this same command: identical options,
identical acknowledgement, dispatched here. It is a name, not a second verb,
so a caller is never asked to choose between them. Prefer \`submit\`.

${ADMISSION_GUIDANCE}`,
      arguments: admissionArguments(),
    },
    {
      name: "worker",
      summary: "Lease and materialize durable ingestion jobs",
      audience: "operator",
      mutates: true,
      blocking: true,
      guidance: `The resident worker is a managed service; an operator runs it directly with
--once to recover stale leases, drain work due now, and exit.

Materialization happens outside SQLite write transactions. URL jobs delegate
a versioned extraction envelope to Agentscrape; an unknown envelope version
is a protocol defect rather than a provider-schema fallback. Completion and
failure are fenced by the attempt token. Signal shutdown stops new claims and
leaves unfinished work recoverable through lease expiry.

Scoped execution requires --once and all three scope options together. It
performs no scheduling, rejects policy or cardinality mismatches before
claim, and never falls back to ordinary queue claims. Offline Runs cannot
authorize URL extraction; online Runs authorize exactly two URL jobs already
bound to that Run and hold a single fenced execution lease. Ordinary workers
skip every operator-controlled Run.`,
      constraints: [
        {
          kind: "requires",
          arguments: [
            "--run",
            "--authorization-digest",
            "--allowed-kind",
            "--once",
          ],
          description:
            "Scoped execution is all-or-nothing: pinning a Run requires both scope proofs and --once.",
        },
      ],
      arguments: [
        {
          name: "--once",
          type: "boolean",
          description: "Recover stale leases, drain work due now, and exit.",
          default: false,
        },
        {
          name: "--worker-id",
          type: "string",
          description: "Diagnostic worker identity.",
        },
        {
          name: "--poll-ms",
          type: "integer",
          description: "Idle polling interval.",
          minimum: 1,
          default: 1000,
        },
        {
          name: "--lease-ms",
          type: "integer",
          description: "Attempt lease duration.",
          minimum: 1,
          default: 60000,
        },
        {
          name: "--heartbeat-ms",
          type: "integer",
          description: "Active lease heartbeat interval.",
          minimum: 1,
          default: 20000,
        },
        {
          name: "--shutdown-grace-ms",
          type: "integer",
          description: "Bounded completion grace after a signal.",
          minimum: 0,
          default: 10000,
        },
        {
          name: "--run",
          type: "integer",
          description: "Pin an operator-controlled Run.",
          minimum: 1,
        },
        {
          name: "--authorization-digest",
          type: "string",
          description:
            "Require the persisted authorization digest (lowercase SHA-256).",
        },
        {
          name: "--allowed-kind",
          type: "string",
          description: "Require a persisted allowed job kind.",
          choices: [
            "text",
            "file",
            "directory",
            "url",
            "recovery_offline",
            "recovery_online",
          ],
          repeatable: true,
        },
      ],
    },
    {
      name: "jobs",
      summary: "Safely inspect and operate on the ingestion ledger",
      audience: "agent",
      guidance:
        "list, run, and stats are structurally read-only and content-safe. show is too unless --reveal-content is passed. retry, cancel, and exclude are explicit operator acts that append transitions and preserve every attempt.",
      subcommands: [
        {
          name: "list",
          summary: "List ledger jobs, newest work first",
          audience: "agent",
          mutates: false,
          guidance:
            "Structurally read-only. Omits durable intent, Artifact bodies, raw URLs, query values, worker names, and detailed diagnostics.",
          arguments: [
            {
              name: "--state",
              type: "string",
              description: "Require an exact job state.",
            },
            {
              name: "--run",
              type: "integer",
              description: "Require membership in a Run.",
              minimum: 1,
            },
            {
              name: "--limit",
              type: "integer",
              description: "Maximum jobs to list.",
              minimum: 1,
              maximum: 1000,
              default: 100,
            },
          ],
        },
        {
          name: "show",
          summary: "Show one job, optionally revealing its Artifact body",
          audience: "agent",
          mutates: true,
          guidance: `An ordinary show is structurally read-only and content-safe.
It includes bounded failure summaries after credential, private-path, and URL
redaction so failed work can be diagnosed through the supported interface.
--reveal-content explicitly reads Artifact bodies and appends a
sensitive-inspection audit record, which is the only durable write this
command can make. Pass it only when the body is genuinely required.`,
          arguments: [
            {
              name: "job-id",
              type: "integer",
              description: "The job to show.",
              positional: true,
              required: true,
              minimum: 1,
            },
            {
              name: "--reveal-content",
              type: "boolean",
              description: "Read Artifact bodies and append an audit record.",
              default: false,
            },
            {
              name: "--actor",
              type: "string",
              description: "Actor recorded on the audit record.",
              default: "operator",
            },
            {
              name: "--max-bytes",
              type: "integer",
              description: "Cap on revealed bytes.",
              minimum: 1,
              default: 5000000,
            },
          ],
        },
        {
          name: "run",
          summary: "Inspect one Run's jobs, counts, and quiescence",
          audience: "agent",
          mutates: false,
          guidance:
            "Reports only opaque IDs and authorization digests, state and kind counts, Attempt counts, quiescence, and bounded safe job views.",
          arguments: [
            {
              name: "run-id",
              type: "integer",
              description: "The Run to inspect.",
              positional: true,
              required: true,
              minimum: 1,
            },
            {
              name: "--limit",
              type: "integer",
              description: "Maximum jobs to include.",
              minimum: 1,
              maximum: 1000,
              default: 100,
            },
          ],
        },
        {
          name: "retry",
          summary: "Return one job to the queue",
          audience: "operator",
          mutates: true,
          guidance: "Appends a transition and preserves every earlier attempt.",
          arguments: [
            {
              name: "job-id",
              type: "integer",
              description: "The job to retry.",
              positional: true,
              required: true,
              minimum: 1,
            },
            {
              name: "--reason",
              type: "string",
              description: "Reason recorded on the transition.",
            },
            {
              name: "--actor",
              type: "string",
              description: "Actor recorded on the transition.",
              default: "operator",
            },
          ],
        },
        {
          name: "cancel",
          summary: "Cancel one job",
          audience: "operator",
          mutates: true,
          arguments: [
            {
              name: "job-id",
              type: "integer",
              description: "The job to cancel.",
              positional: true,
              required: true,
              minimum: 1,
            },
            {
              name: "--reason",
              type: "string",
              description: "Reason recorded on the transition.",
            },
            {
              name: "--actor",
              type: "string",
              description: "Actor recorded on the transition.",
              default: "operator",
            },
          ],
        },
        {
          name: "exclude",
          summary: "Dispose of one job that will not be recovered",
          audience: "operator",
          mutates: true,
          guidance:
            "The operator disposition for work that is never coming back; an excluded job stops counting as stranded in doctor.",
          arguments: [
            {
              name: "job-id",
              type: "integer",
              description: "The job to exclude.",
              positional: true,
              required: true,
              minimum: 1,
            },
            {
              name: "--reason",
              type: "string",
              description: "Why it is being abandoned.",
              required: true,
            },
            {
              name: "--actor",
              type: "string",
              description: "Actor recorded on the transition.",
              default: "operator",
            },
          ],
        },
        {
          name: "stats",
          summary: "Aggregate ledger counts by state and kind",
          audience: "agent",
          mutates: false,
          arguments: [
            {
              name: "--run",
              type: "integer",
              description: "Restrict the aggregate to one Run.",
              minimum: 1,
            },
          ],
        },
      ],
    },
    {
      name: "doctor",
      summary: "Check database, Artifact, lease, and provider health",
      audience: "operator",
      mutates: true,
      guidance: `The checks themselves use a structurally read-only connection and never
mutate the ledger; triage stays an explicit operator act. This command
declares mutates: true only because --notify writes notification state and
posts through terminal-notifier. Without --notify it changes nothing.

Reports safe status and count data for SQLite integrity, schema, Artifact
references, leases, stranded ingestion, Agentscrape availability, and the
share ingress. Exits 1 when a required check fails.

share_ingress reads the registration a serving ingress publishes and asks it
for GET /v1/health on its own address — this machine only, never the open
web. No registration is ok, because the share service is opt-in. A
registration whose process is gone warns. A registered, running ingress that
cannot answer fails: that is a bind that stopped serving, and shares are
being dropped while the ledger has nothing to show for it.

A stranded ingestion job is one in blocked or failed that carries a failure
class: an attempt ran, nothing will revive it, and links accepted at
admission never became searchable. Excluded and cancelled are operator
dispositions and are not stranded. A job withheld at admission before any
attempt is reported separately as admission_review, because an undecided
question is not a defect.`,
      arguments: [
        {
          name: "--notify",
          type: "boolean",
          description:
            'Post an operator notification when the stranded count rises above the last notified value, and report what it did under "notification". A steady backlog stays silent and a missing notifier is not an error.',
          default: false,
        },
      ],
    },
    {
      name: "backup",
      summary: "Create and verify private SQLite recovery snapshots",
      audience: "operator",
      guidance:
        "A backup is a bundle: database.sqlite plus a body-free manifest of schema, timestamps, source paths, configuration, and required Artifact digests.",
      subcommands: [
        {
          name: "create",
          summary: "Publish a private, SQLite-consistent backup bundle",
          audience: "operator",
          mutates: true,
          guidance: `The bundle contains database.sqlite and a body-free manifest with schema,
timestamps, source paths, configuration, and required Artifact digests and
references. Creation uses SQLite VACUUM INTO through the Index owner's
writable store, so committed WAL state is captured without stopping the
worker permanently. Publication is atomic and never replaces an existing
backup.`,
          constraints: [
            {
              kind: "one_of",
              arguments: ["backup-path", "--output"],
              required: true,
              description: "The destination, positionally or as a flag.",
            },
          ],
          arguments: [
            {
              name: "backup-path",
              type: "string",
              description: "Backup destination; it must not already exist.",
              positional: true,
              format: "path",
              direction: "out",
            },
            {
              name: "--output",
              type: "string",
              description: "Backup destination; it must not already exist.",
              format: "path",
              direction: "out",
            },
            {
              name: "--artifact-root",
              type: "string",
              description:
                "Artifact store to check (default: the configured local store).",
              format: "path",
              direction: "in",
            },
          ],
        },
        {
          name: "verify",
          summary: "Restore into isolation and run all recovery checks",
          audience: "operator",
          mutates: false,
          guidance: `Never opens or migrates the source database. It copies snapshot bytes into a
private temporary restore, runs SQLite integrity and schema checks,
reconciles the Artifact reference manifest, verifies each required Artifact
digest, and proves that FTS can be rebuilt from retained indexed content. The
temporary restore is always removed, so nothing durable changes. Exits 1 if
any check fails.`,
          constraints: [
            {
              kind: "one_of",
              arguments: ["backup-path", "--backup"],
              required: true,
              description: "The bundle to verify, positionally or as a flag.",
            },
          ],
          arguments: [
            {
              name: "backup-path",
              type: "string",
              description: "Backup bundle to verify.",
              positional: true,
              format: "path",
              direction: "in",
            },
            {
              name: "--backup",
              type: "string",
              description: "Backup bundle to verify.",
              format: "path",
              direction: "in",
            },
            {
              name: "--artifact-root",
              type: "string",
              description:
                "Artifact store to check (default: the source path recorded in the manifest).",
              format: "path",
              direction: "in",
            },
          ],
        },
      ],
    },
    {
      name: "recovery",
      summary: "Verify and durably admit a frozen legacy recovery generation",
      audience: "operator",
      guidance:
        "A frozen, one-time legacy migration. import verifies and admits the generation offline; online prepares or executes the separately authorized two-candidate network backfill.",
      subcommands: [
        {
          name: "import",
          summary: "Verify a frozen generation and durably admit its Run",
          audience: "operator",
          mutates: true,
          guidance: `Accepts only the hash-bound 1,088-row frozen recovery contract. It verifies
all generation files and approved local Markdown without invoking Agentscrape
or any other network backend. Linkctl frontmatter is parsed locally; its
exact URL must match the candidate, while only the frontmatter-free body
enters the Artifact store.

--dry-run performs no database or Artifact-store writes. Admission creates
one pending recovery Run, stable candidate outcomes, 584 ordered legacy-links
memberships, body-free Secretary observations, 581 runnable offline jobs, 11
blocked jobs, and 37 exclusions. --authorize-offline immutably binds that Run
to the generation digest and the logical recovery_offline scope, which
selects only its 581 recovery file jobs while rejecting URL and unrelated
file claims. The two controlled-online jobs remain blocked until a separate
run explicitly authorizes egress. Comparison URIs are diagnostic aliases only
and never merge candidate outcomes.

Output contains opaque generation, candidate, Run, and Attempt IDs, bounded
states and classifications, counts, and snapshot/Artifact hashes — never
exact candidate URLs, private locators, message bodies, or credentials.`,
          constraints: [
            {
              kind: "one_of",
              arguments: ["generation", "--manifest-generation"],
              required: true,
              description:
                "The frozen generation descriptor, positionally or as a flag.",
            },
            {
              kind: "conflicts",
              arguments: ["--authorize-offline", "--dry-run"],
              description: "A dry run authorizes nothing.",
            },
          ],
          arguments: [
            {
              name: "generation",
              type: "string",
              description:
                "Atomic generation pointer, directory, or generation.json.",
              positional: true,
              format: "path",
              direction: "in",
            },
            {
              name: "--manifest-generation",
              type: "string",
              description:
                "Atomic generation pointer, directory, or generation.json.",
              format: "path",
              direction: "in",
            },
            {
              name: "--artifact-root",
              type: "string",
              description: "Declared root for legacy Markdown.",
              format: "path",
              direction: "in",
              repeatable: true,
            },
            {
              name: "--artifact-store",
              type: "string",
              description:
                "Destination Artifact store for admitted searchable bodies.",
              format: "path",
              direction: "out",
            },
            {
              name: "--authorize-offline",
              type: "boolean",
              description:
                "Bind the admitted Run to recovery_offline scoped execution.",
              default: false,
            },
            {
              name: "--dry-run",
              type: "boolean",
              description:
                "Verify all descriptors, hashes, rows, and frontmatter only.",
              default: false,
            },
          ],
        },
        {
          name: "online",
          summary:
            "Prepare or execute the controlled two-candidate online backfill",
          audience: "operator",
          mutates: true,
          guidance: `Preparation restore-verifies the pinned post-offline snapshot, rechecks
SQLite, Artifact, FTS, retrieval, permission, disk, worker-quiescence,
offline Run, generation, and exact two-candidate approval gates before
creating a separate immutable online Run. The recovery_online scope maps only
its two URL jobs, and ordinary workers are fenced while its concurrency-one
execution lease is active.

--execute invokes Agentscrape as the sole extractor. Item-specific failure
leaves the sibling eligible; shared infrastructure, authentication,
configuration, or integrity failure pauses before another claim. Replay skips
completed effects and resumes only the same incomplete jobs. Terminal
non-success is completed_with_review. Snapshot rollback is local-only and
cannot undo remote requests.`,
          arguments: [
            {
              name: "--manifest-generation",
              type: "string",
              description:
                "Atomic generation pointer, directory, or generation.json.",
              format: "path",
              direction: "in",
              required: true,
            },
            {
              name: "--offline-run",
              type: "integer",
              description: "Terminal linked offline Run.",
              required: true,
              minimum: 1,
            },
            {
              name: "--post-offline-snapshot",
              type: "string",
              description:
                "Verified rollback snapshot created after the offline drain.",
              format: "path",
              direction: "in",
              required: true,
            },
            {
              name: "--generation-digest",
              type: "string",
              description: "Pinned frozen-generation digest.",
              required: true,
            },
            {
              name: "--approval-digest",
              type: "string",
              description: "Immutable online-allowlist file digest.",
              required: true,
            },
            {
              name: "--snapshot-digest",
              type: "string",
              description: "Post-offline snapshot database digest.",
              required: true,
            },
            {
              name: "--execute",
              type: "boolean",
              description:
                "Drain eligible work now through Agentscrape; otherwise prepare only.",
              default: false,
            },
            {
              name: "--artifact-root",
              type: "string",
              description: "Declared root for legacy Markdown.",
              format: "path",
              direction: "in",
              repeatable: true,
            },
            {
              name: "--artifact-store",
              type: "string",
              description: "Destination Artifact store.",
              format: "path",
              direction: "out",
            },
            {
              name: "--worker-id",
              type: "string",
              description: "Opaque scoped worker identity.",
            },
            {
              name: "--lease-ms",
              type: "integer",
              description: "Attempt lease duration.",
              default: 60000,
            },
            {
              name: "--heartbeat-ms",
              type: "integer",
              description: "Active lease heartbeat interval.",
              default: 20000,
            },
            {
              name: "--shutdown-grace-ms",
              type: "integer",
              description: "Bounded completion grace after a signal.",
              default: 10000,
            },
          ],
        },
      ],
    },
    {
      name: "delete",
      summary: "Delete one selected document with explicit confirmation",
      audience: "agent",
      mutates: true,
      guidance: `Deletion purges everything the ingestion created: the document, chunks, and
FTS rows, then the Resource and its aliases, Artifact registrations,
collection memberships, provenance, relations, and observations. Artifact
bytes are unlinked once no surviving Resource references them, so content
shared with another Resource is kept.

The job and its attempts survive with their states, timings, and outcomes,
because that history is what makes the ledger auditable. Their intent is
redacted: the locator, text payload, and title are removed, so a deleted URL
is no longer recoverable from the job. The idempotency key and intent hash
are one-way digests and are retained. Re-submitting the same source
afterwards derives a fresh key and admits a new job.`,
      constraints: [
        {
          kind: "one_of",
          arguments: ["--document-id", "--source-uri"],
          required: true,
          description: "Exactly one selector.",
        },
      ],
      arguments: [
        {
          name: "--document-id",
          type: "integer",
          description: "The document to delete.",
        },
        {
          name: "--source-uri",
          type: "string",
          description: "The source URI of the document to delete.",
        },
        {
          name: "--confirm",
          type: "string",
          description: "The literal confirmation token.",
          choices: ["delete"],
          required: true,
        },
      ],
    },
    {
      name: "retag",
      summary: "Derive and apply structural tags across every document",
      audience: "operator",
      mutates: true,
      guidance: `Deterministically derives structural tags from each document's source_type,
URL domain, and collection membership, unioned with its existing tags
(legacy-recovery and any user tag are always preserved). Every document's
documents.tags and the denormalized chunks_fts.tags are kept in sync in one
transaction per changed document.

Re-running is idempotent: a document whose derived tags already match its
stored tags is reported unchanged and is not rewritten. --dry-run computes
and reports the same per-document before/after diffs and totals without
touching the database.`,
      arguments: [
        {
          name: "--dry-run",
          type: "boolean",
          description:
            "Report per-document tag diffs and counts without writing.",
          default: false,
        },
      ],
    },
    {
      name: "tags",
      summary: "List indexed tags with document counts",
      audience: "agent",
      mutates: false,
      arguments: [
        {
          name: "--limit",
          type: "integer",
          description: "Number of tags (max 500).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      ],
    },
    {
      name: "sources",
      summary: "Apply, inspect, schedule, pause, and resume recurring sources",
      audience: "agent",
      guidance:
        "Source IDs are stable declarative identities; mutable handles and homepages are payload, not identity. apply is the only way a definition changes, and sync only admits durable Runs — no HTTP work, discovery, or document writes happen here.",
      subcommands: [
        {
          name: "apply",
          summary:
            "Durably create or update source definitions from a manifest",
          audience: "operator",
          mutates: true,
          guidance: `Reads a versioned manifest (default: the empty bundled config/sources.example.json)
and durably creates or updates
matching definitions. A higher version may declaratively enable or disable a
source; apply never deletes a definition or runs it implicitly. Re-applying
identical content is a no-op. Raising a source's version without changing its
kind admits the new content; changing content without raising the version is
refused.`,
          arguments: [
            {
              name: "--manifest",
              type: "string",
              description:
                "Versioned source manifest (default: the empty bundled config/sources.example.json).",
              format: "path",
              direction: "in",
            },
            {
              name: "--overlay",
              type: "string",
              description: "Overlay applied over the manifest.",
              format: "path",
              direction: "in",
            },
            {
              name: "--actor",
              type: "string",
              description: "Actor recorded on the audit evidence.",
              default: "operator",
            },
            {
              name: "--reason",
              type: "string",
              description: "Reason recorded on the audit evidence.",
            },
          ],
        },
        {
          name: "list",
          summary: "List source definitions and their health",
          audience: "agent",
          mutates: false,
          guidance:
            "Unknown future kinds remain listable and showable, but sync will not admit work for them.",
          arguments: [
            {
              name: "--limit",
              type: "integer",
              description: "Maximum sources to list (max 1000).",
              minimum: 1,
              maximum: 1000,
              default: 500,
            },
          ],
        },
        {
          name: "show",
          summary: "Show one source definition",
          audience: "agent",
          mutates: false,
          guidance:
            "Source IDs are stable declarative identities; mutable handles and homepages are payload, not identity. Definitions retain versioned schedules, bounded limits, collection and sensitivity policy, and credential references without credential values.",
          arguments: [
            {
              name: "source-id",
              type: "string",
              description: "Stable source ID.",
              positional: true,
              required: true,
            },
          ],
        },
        {
          name: "status",
          summary: "Report scheduling and Run status for one or all sources",
          audience: "agent",
          mutates: false,
          guidance:
            "A Run's attempted cursor is in-progress evidence, separate from its committed checkpoint. A checkpoint may advance only after a complete successful window has durably admitted or explicitly suppressed every discovered observation.",
          arguments: [
            {
              name: "source-id",
              type: "string",
              description: "Restrict the report to one source.",
              positional: true,
            },
          ],
        },
        {
          name: "sync",
          summary:
            "Durably admit discovery Runs for one source or every due one",
          audience: "operator",
          mutates: true,
          blocking: true,
          guidance: `Two usage forms:
  node packages/brain/dist/src/cli.js sources sync SOURCE_ID [--due]   one named source
  node packages/brain/dist/src/cli.js sources sync --due               every overdue source

Giving neither is refused as bad_source_sync. --due alongside a source ID
narrows that one source to "only if actually due"; it is not an alternative
selector. Contract version 1 has no vocabulary for "at least one of", which
is why this is stated here rather than in constraints.

Sync performs no HTTP work, remote discovery, extraction, or document writes;
those remain worker and provider work. Schedule evaluation admits at most one
catch-up Run for each overdue source and advances its next due time from the
current evaluation, not once per missed wall-clock tick. Paused and disabled
sources admit no Runs.

--wait waits for the admitted discovery Run to finish through the resident
worker and returns a scheduler-facing execution receipt; it does not wait for
every discovered child URL extraction. A timeout exits 124 and a non-success
terminal outcome exits 1. For supervisors that treat every nonzero exit as an
execution failure, --wait-timeout-ok keeps timed_out:true in JSON but exits 0
because the durable Run continues independently.`,
          constraints: [
            {
              kind: "requires",
              arguments: ["--wait-timeout-ok", "--wait"],
              description: "There is no timeout to forgive without --wait.",
            },
            {
              kind: "conflicts",
              arguments: ["--wait", "--dry-run"],
              description: "A dry run admits no Run to wait for.",
            },
          ],
          arguments: [
            {
              name: "source-id",
              type: "string",
              description: "The source to sync.",
              positional: true,
            },
            {
              name: "--due",
              type: "boolean",
              description:
                "Sync every overdue source, or narrow a named source to only-if-due.",
              default: false,
            },
            {
              name: "--dry-run",
              type: "boolean",
              description: "Report what would be admitted without writing.",
              default: false,
            },
            {
              name: "--limit",
              type: "integer",
              description: "Maximum due sources to admit in one evaluation.",
              minimum: 1,
              default: 1000,
            },
            {
              name: "--wait",
              type: "boolean",
              description:
                "Wait for the admitted discovery Run's execution receipt.",
              default: false,
            },
            {
              name: "--wait-timeout-seconds",
              type: "integer",
              description: "Wait budget (1..3600).",
              minimum: 1,
              maximum: 3600,
              default: 300,
            },
            {
              name: "--wait-timeout-ok",
              type: "boolean",
              description:
                "Keep timed_out:true in JSON but exit 0 on a wait timeout.",
              default: false,
            },
            {
              name: "--wait-poll-ms",
              type: "integer",
              description: "Wait polling interval (25..5000).",
              minimum: 25,
              maximum: 5000,
              default: 250,
            },
          ],
        },
        {
          name: "pause",
          summary: "Pause a source so it admits no Runs",
          audience: "operator",
          mutates: true,
          guidance:
            "Pause, resume, and configuration changes append audit evidence without removing earlier Runs or checkpoints.",
          arguments: [
            {
              name: "source-id",
              type: "string",
              description: "The source to pause.",
              positional: true,
              required: true,
            },
            {
              name: "--actor",
              type: "string",
              description: "Actor recorded on the audit evidence.",
              default: "operator",
            },
            {
              name: "--reason",
              type: "string",
              description: "Reason recorded on the audit evidence.",
            },
          ],
        },
        {
          name: "resume",
          summary: "Resume a paused source",
          audience: "operator",
          mutates: true,
          arguments: [
            {
              name: "source-id",
              type: "string",
              description: "The source to resume.",
              positional: true,
              required: true,
            },
            {
              name: "--actor",
              type: "string",
              description: "Actor recorded on the audit evidence.",
              default: "operator",
            },
            {
              name: "--reason",
              type: "string",
              description: "Reason recorded on the audit evidence.",
            },
          ],
        },
      ],
    },
    {
      name: "guide",
      summary: "Print the stable machine-readable agent contract",
      audience: "agent",
      mutates: false,
      guidance:
        "This document. It is the single authorship of the CLI's self-description; --help, --agent-help, and --agent-teaser are rendered from it.",
      arguments: [],
    },
    {
      name: "prompt",
      summary: "Print a prompt harnesses can use to write their own docs",
      audience: "operator",
      mutates: false,
      guidance:
        "Authoring scaffolding, not a research verb: it emits a prompt a human feeds to a harness that is writing documentation about this CLI. An agent already working with AgentStack Brain has the contract itself and gains nothing from it mid-task.",
      arguments: [],
    },
    {
      name: "help",
      summary: "Show help for a command",
      audience: "operator",
      mutates: false,
      guidance:
        "The human help renderer. A programmatic caller reads `guide --json` instead, and a generated call surface already carries every description this prints.",
      arguments: [
        {
          name: "command",
          type: "string",
          description:
            "The command to explain, space-joined for a nested one. Omitted, the top-level help is printed.",
          positional: true,
        },
      ],
    },
  ],
};

/**
 * One argument relation, as a sentence.
 *
 * Authored here rather than in the help renderer because two surfaces say it:
 * `--help` prints it under "Argument rules", and the MCP mapping puts it in
 * the tool description, since a rule a caller cannot see is a rule a caller
 * breaks. `spell` renames the arguments for the surface doing the asking — MCP
 * advertises properties, not flags.
 */
export function constraintSentence(
  constraint: ContractConstraint,
  spell: (name: string) => string = (name) => name,
): string {
  const names = constraint.arguments.map(spell);
  const joined = names.join(", ");
  const rule =
    constraint.kind === "one_of"
      ? constraint.required === true
        ? `exactly one of ${joined}`
        : `at most one of ${joined}`
      : constraint.kind === "at_least_one"
        ? `at least one of ${joined}`
        : constraint.kind === "conflicts"
          ? `${joined} may not be combined`
          : `${names[0]} requires ${names.slice(1).join(", ")}`;
  return constraint.description === undefined
    ? `${rule}.`
    : `${rule}: ${constraint.description}`;
}

export interface ContractNode {
  path: string[];
  command: ContractCommand;
}

/** Every command in the tree, with its full path. Groups included. */
export function walkCommands(
  commands: ContractCommand[] = AGENT_CONTRACT.commands,
  prefix: string[] = [],
): ContractNode[] {
  const out: ContractNode[] = [];
  for (const command of commands) {
    const path = [...prefix, command.name];
    out.push({ path, command });
    if (command.subcommands !== undefined) {
      out.push(...walkCommands(command.subcommands, path));
    }
  }
  return out;
}

export function isGroup(command: ContractCommand): boolean {
  return command.subcommands !== undefined;
}

/** Every invocable command, by full space-joined path. */
export function leafPaths(): string[] {
  return walkCommands()
    .filter((node) => !isGroup(node.command))
    .map((node) => node.path.join(" "));
}

/** Every spelling a command answers to: its name first, then its aliases. */
export function commandSpellings(command: ContractCommand): string[] {
  return [command.name, ...(command.aliases ?? [])];
}

/**
 * Resolve a space-joined path, or a bare group/leaf name at the top level.
 *
 * An alias resolves to the command that owns it, so `help ingest` and
 * `ingest --help` reach `submit` rather than reporting an unknown command.
 */
export function findCommand(path: string): ContractCommand | null {
  const segments = path.trim().split(/\s+/).filter(Boolean);
  if (segments.length === 0) return null;
  let level: ContractCommand[] | undefined = AGENT_CONTRACT.commands;
  let found: ContractCommand | null = null;
  for (const segment of segments) {
    const next: ContractCommand | undefined = level?.find((command) =>
      commandSpellings(command).includes(segment),
    );
    if (next === undefined) return null;
    found = next;
    level = next.subcommands;
  }
  return found;
}

/** Canonical name of the top-level command a spelling reaches, or null. */
export function canonicalTopLevelCommand(name: string): string | null {
  const command = AGENT_CONTRACT.commands.find((candidate) =>
    commandSpellings(candidate).includes(name),
  );
  return command?.name ?? null;
}

/**
 * Every top-level spelling the CLI accepts, aliases included.
 *
 * The dispatcher matches what a person types, and a person may still type an
 * alias; the contract decides which of those spellings is canonical.
 */
export const TOP_LEVEL_COMMAND_NAMES: readonly string[] =
  AGENT_CONTRACT.commands.flatMap(commandSpellings);
