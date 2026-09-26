import { lstatSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.js";

const DEFAULT_DATABASE_DISPLAY = "~/.local/state/agentstack/brain/research.db";
const environment = new AsyncLocalStorage<{ env: NodeJS.ProcessEnv; signal?: AbortSignal }>();

export function brainEnvironment(): NodeJS.ProcessEnv { return environment.getStore()?.env ?? process.env; }
export function brainSignal(): AbortSignal | undefined { return environment.getStore()?.signal; }
export function withBrainEnvironment<T>(env: NodeJS.ProcessEnv, body: () => T, signal?: AbortSignal): T { return environment.run({ env, signal }, body); }
export function brainStateRoot(env: NodeJS.ProcessEnv = brainEnvironment(), home?: string): string {
  return join(env.AGENTSTACK_STATE_DIR ?? join(home ?? env.HOME ?? homedir(), ".local", "state", "agentstack"), "brain");
}

interface PathState {
  exists: boolean;
  symlink: boolean;
  directory: boolean;
  regularFile: boolean;
}

export function defaultDatabasePath(home?: string): string {
  return join(brainStateRoot(brainEnvironment(), home), "research.db");
}

function pathState(path: string): PathState {
  try {
    const stat = lstatSync(path);
    return {
      exists: true,
      symlink: stat.isSymbolicLink(),
      directory: stat.isDirectory(),
      regularFile: stat.isFile(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        exists: false,
        symlink: false,
        directory: false,
        regularFile: false,
      };
    throw error;
  }
}

function locationConflict(message: string, recovery: string): never {
  throw new CliError("db_location_conflict", message, { recovery });
}

export function isDefaultDatabasePath(path: string, home?: string): boolean {
  return resolve(path) === resolve(defaultDatabasePath(home));
}

export function assertDefaultDatabaseTargetSafe(
  path: string,
  home?: string,
): void {
  if (!isDefaultDatabasePath(path, home)) return;
  const target = defaultDatabasePath(home);
  const dataDirectory = dirname(target);
  const directoryState = pathState(dataDirectory);
  const targetState = pathState(target);

  if (
    directoryState.exists &&
    (directoryState.symlink || !directoryState.directory)
  )
    locationConflict(
      `AgentStack Brain data directory must be a real directory: ${dataDirectory}`,
      `Create ${dirname(DEFAULT_DATABASE_DISPLAY)} as a private directory, not a symlink.`,
    );
  if (targetState.exists && (targetState.symlink || !targetState.regularFile))
    locationConflict(
      `AgentStack Brain default database must be a regular file: ${target}`,
      `Restore a verified standalone database at ${DEFAULT_DATABASE_DISPLAY}.`,
    );
}

export function assertDefaultDatabaseLocationReady(home?: string): void {
  assertDefaultDatabaseTargetSafe(defaultDatabasePath(home), home);
}
