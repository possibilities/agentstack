import { homedir } from "node:os";
import { join } from "node:path";

export const defaultPort = 39231;

export function stateDir(): string {
  return process.env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack");
}
