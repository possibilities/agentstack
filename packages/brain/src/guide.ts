import {
  AGENT_CONTRACT,
  type AgentContract,
  isGroup,
  walkCommands,
} from "./contract.js";

/**
 * `guide --json` emits the fleet agent contract verbatim.
 *
 * It is authored in src/contract.ts and nowhere else: `--help`,
 * `--agent-help`, `--agent-teaser`, and the harness-docs prompt below are all
 * renders of the same document.
 */
export function buildGuide(): AgentContract {
  return AGENT_CONTRACT;
}

/** Every command a harness should look at, so the list cannot go stale. */
function inspectionCommands(): string {
  return walkCommands()
    .filter((node) => !isGroup(node.command))
    .filter((node) => node.command.audience !== "internal")
    .map((node) => `  node packages/brain/dist/src/cli.js help ${node.path.join(" ")}`)
    .join("\n");
}

export const HARNESS_DOCS_PROMPT = `You are writing local agent-facing documentation for the AgentStack Brain Package API and its internal operator dispatcher.

Goal: document typed Package API operations for search and durable admission. The internal dispatcher is for operator recovery; shared AgentStack transports own serving.

Inspect, in this order:

  node packages/brain/dist/src/cli.js guide --json
  node packages/brain/dist/src/cli.js --agent-help
${inspectionCommands()}

Document:
1. When to use context versus search -> get -> cite.
2. Exact --json examples and the citation fields.
3. Zero-result recovery through alternate terms, tags, and sources.
4. Generic explicit ingestion and guarded deletion.
5. The ownership boundary: AgentStack Brain owns durable admission, ingestion jobs, Artifact snapshots, and index writes; Agentscrape owns URL extraction/network/backend behavior.
6. Queued, duplicate, and already_indexed submission acknowledgements, explicit idempotency conflicts, and --wait observation.
7. Tests use temporary state and stubbed extraction; they never read a live research store.
8. All default state is rooted in AGENTSTACK_STATE_DIR/brain, defaulting to ~/.local/state/agentstack/brain. Only the internal dispatcher accepts --db.
9. Share ingress uses AGENTSTACK_BRAIN_SHARE_HOST (default 127.0.0.1) and AGENTSTACK_BRAIN_SHARE_PORT (default 8877). The owner controls its lifetime.

Keep it short enough for an AGENTS.md or harness instruction file.`;
