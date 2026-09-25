/** One spelling of every URL, shared by `publish`, `open`, the stub documents
 * and the server — a link written into the vault must still resolve years
 * later, so the shapes live here rather than in whichever module builds one. */

export const DEFAULT_PORT = 8777;
/** Artifact bytes bind a second loopback port so they land on an origin of
 * their own — the isolation serve.ts relies on. Paths are unchanged, so a
 * citation written before the split still resolves. */
export const DEFAULT_ARTIFACT_PORT = 8778;
export const DEFAULT_HOST = "127.0.0.1";

/** Moves as new versions land: what a human wants bookmarked. */
export function latestArtifactUrl(name: string): string {
  return `/a/${name}/`;
}

/** Immutable: safe to cite, safe to cache forever. */
export function versionArtifactUrl(name: string, version: string): string {
  return `/a/${name}/v/${version}/`;
}

export function documentUrl(slug: string): string {
  return `/d/${slug}`;
}

export function origin(port: number, host: string = DEFAULT_HOST): string {
  return `http://${host}:${port}`;
}

export function absolute(port: number, path: string, host: string = DEFAULT_HOST): string {
  return `${origin(port, host)}${path}`;
}
