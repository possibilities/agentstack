import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface QueuePaths {
  dataHome: string;
  queue: string;
  retry: string;
  failed: string;
  /** Private transient coordination state: generation claims and retirement quarantine. */
  private: string;
}

function validatedDataRoot(name: string, value: string): string {
  if (!value || value.includes("\0") || !isAbsolute(value))
    throw new Error(`${name} must be a non-empty absolute path without NUL bytes`);
  return resolve(value);
}

export function resolveQueuePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): QueuePaths {
  const stateRoot = env.AGENTSTACK_STATE_DIR !== undefined
    ? validatedDataRoot("AGENTSTACK_STATE_DIR", env.AGENTSTACK_STATE_DIR)
    : join(home, ".local", "state", "agentstack");
  const dataHome = join(stateRoot, "scrape");
  return {
    dataHome,
    queue: join(dataHome, "queue"),
    retry: join(dataHome, "retry"),
    failed: join(dataHome, "failed"),
    private: join(dataHome, "private"),
  };
}

export function resolveDataHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return resolveQueuePaths(env, home).dataHome;
}
