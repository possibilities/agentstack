import { isAbsolute, join } from "node:path";

export type Environ = Record<string, string | undefined>;

/** Relative XDG overrides are ignored per the basedir spec, not honored badly. */
function xdgBase(env: Environ, name: string, home: string, fallback: string[]): string {
  const value = env[name];
  return value && isAbsolute(value) ? value : join(home, ...fallback);
}

/** Authoritative user data: databases and content stores live here. */
export function dataDirectory(env: Environ, home: string, app: string): string {
  return join(xdgBase(env, "XDG_DATA_HOME", home, [".local", "share"]), app);
}

/** Rebuildable or losable bookkeeping: receipts, locks. */
export function stateDirectory(env: Environ, home: string, app: string): string {
  return join(xdgBase(env, "XDG_STATE_HOME", home, [".local", "state"]), app);
}

export function configDirectory(env: Environ, home: string, app: string): string {
  return join(xdgBase(env, "XDG_CONFIG_HOME", home, [".config"]), app);
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
