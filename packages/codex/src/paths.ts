import { homedir } from "node:os";
import { join } from "node:path";

// Required runtime, installed and versioned by codexnk through AgentStart.
// Deliberately independent of PATH and per-request or Codex environment settings.
export function codexRuntimePath(): string {
  return join(homedir(), ".local", "libexec", "codexnk", "codex");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack");
}
