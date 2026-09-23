import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack");
}
