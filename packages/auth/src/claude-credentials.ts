import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Internal credential access only. None of these values belong in a Package API result. */
export type ClaudeCredentialOptions = {
  platform?: NodeJS.Platform;
  security?: (args: string[]) => Promise<{ code: number | null; stdout: string }>;
};

export class ClaudeCredentialError extends Error {
  constructor(readonly code: "credentials_unavailable" | "credentials_unsafe" | "identity_invalid" | "keychain_conflict" | "keychain_unavailable") {
    super(code === "credentials_unsafe" ? "Claude account credentials are not private"
      : code === "identity_invalid" ? "Claude account identity is unavailable; sign in again"
      : code === "keychain_conflict" ? "Claude account keychain service is already occupied"
      : code === "keychain_unavailable" ? "Claude account keychain is unavailable"
      : "Claude account credentials are unavailable; sign in again");
  }
}

export function claudeRuntimePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  const configured = env.AGENTSTACK_CLAUDE_BIN;
  return configured ? isAbsolute(configured) ? configured : resolve(home, configured.replace(/^~\//, "")) : join(home, ".local", "bin", "claude");
}

export function claudeLoginInvocation(env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[] } {
  const claude = claudeRuntimePath(env);
  // Native auth login supports readline paste-back, but has no no-browser flag.
  // The macOS OS guard fails closed; BROWSER is also set by both callers.
  return process.platform === "darwin" ? {
    bin: "/usr/bin/sandbox-exec",
    args: ["-p", '(version 1) (allow default) (deny process-exec (literal "/usr/bin/open"))', claude, "auth", "login", "--claudeai"],
  } : { bin: claude, args: ["auth", "login", "--claudeai"] };
}

export function claudeConfigRoot(stateDir: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ClaudeCredentialError("credentials_unsafe");
  return resolve(stateDir, "worker-accounts", id, "claude");
}

/** Native Claude hashes the NFC config path, never the default/shared service. */
export function claudeKeychainService(configRoot: string): string {
  if (!isAbsolute(configRoot)) throw new ClaudeCredentialError("credentials_unsafe");
  return `Claude Code-credentials-${createHash("sha256").update(configRoot.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

export function claudeKeychainAccount(): string {
  const username = userInfo().username;
  return /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user";
}

const security: NonNullable<ClaudeCredentialOptions["security"]> = (args) => new Promise((done) => {
  execFile("/usr/bin/security", args, { encoding: "utf8", timeout: 5_000, maxBuffer: 128_000 }, (error, stdout) => {
    done({ code: error ? typeof error.code === "number" ? error.code : null : 0, stdout });
  });
});
const onMac = (options: ClaudeCredentialOptions) => (options.platform ?? process.platform) === "darwin";
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => { throw new ClaudeCredentialError("credentials_unavailable"); });
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new ClaudeCredentialError("credentials_unsafe");
}

async function privateJson(path: string, optional = false): Promise<Record<string, unknown> | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ClaudeCredentialError("credentials_unavailable");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 128_000)
      throw new ClaudeCredentialError("credentials_unsafe");
    // Bound the actual read too: a native writer may replace or grow a file concurrently.
    const buffer = Buffer.alloc(128_001);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128_000) throw new ClaudeCredentialError("credentials_unsafe");
    try {
      const value = record(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      if (!value) throw new Error();
      return value;
    } catch { throw new ClaudeCredentialError("credentials_unavailable"); }
  } finally { await handle.close(); }
}

async function ownedProfile(stateDir: string, id: string): Promise<string> {
  const root = claudeConfigRoot(stateDir, id);
  for (const path of [resolve(stateDir), resolve(stateDir, "worker-accounts"), resolve(stateDir, "worker-accounts", id), root])
    await privateDirectory(path);
  const marker = await privateJson(join(root, ".agentstack-profile.json"));
  if (marker?.version !== 1 || marker.service !== claudeKeychainService(root)) throw new ClaudeCredentialError("credentials_unsafe");
  return root;
}

const created = (error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; };

/**
 * Native Claude stores credentials through `security`, which resolves the login keychain under $HOME.
 * The account HOME links the user's own keychains so that write never finds no default keychain.
 */
async function linkUserKeychains(accountHome: string): Promise<void> {
  const library = join(accountHome, "Library"), link = join(library, "Keychains");
  const target = join(userInfo().homedir, "Library", "Keychains");
  await mkdir(library, { mode: 0o700 }).catch(created);
  await privateDirectory(library);
  const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  // A real directory here is a keychain created under the account HOME; never replace it.
  if (existing && !existing.isSymbolicLink()) throw new ClaudeCredentialError("keychain_unavailable");
  if (existing && await readlink(link) === target) return;
  if (existing) await unlink(link);
  await symlink(target, link);
}

export async function prepareClaudeProfile(stateDir: string, id: string, options: ClaudeCredentialOptions = {}): Promise<void> {
  const root = claudeConfigRoot(stateDir, id);
  await mkdir(root, { mode: 0o700 }).catch(created);
  for (const path of [resolve(stateDir), resolve(stateDir, "worker-accounts"), resolve(stateDir, "worker-accounts", id), root])
    await privateDirectory(path);
  if (onMac(options)) await linkUserKeychains(resolve(stateDir, "worker-accounts", id));
  const marker = await privateJson(join(root, ".agentstack-profile.json"), true);
  if (marker) { await ownedProfile(stateDir, id); return; }
  // A fresh profile must not claim an existing native store or an 8-digit service-hash collision.
  if (await privateJson(join(root, ".credentials.json"), true) || await privateJson(join(root, ".claude.json"), true))
    throw new ClaudeCredentialError("credentials_unsafe");
  if (onMac(options)) {
    const prior = await (options.security ?? security)(["find-generic-password", "-s", claudeKeychainService(root)]);
    if (prior.code !== 44) throw new ClaudeCredentialError(prior.code === 0 ? "keychain_conflict" : "keychain_unavailable");
  }
  await writeFile(join(root, ".agentstack-profile.json"), JSON.stringify({ version: 1, service: claudeKeychainService(root) }), { mode: 0o600, flag: "wx" });
}

export async function readClaudeCredentials(stateDir: string, id: string, options: ClaudeCredentialOptions = {}): Promise<{
  access: string; refresh: string; identity: string; digest: string;
}> {
  const root = await ownedProfile(stateDir, id);
  let value: Record<string, unknown> | null = null;
  if (onMac(options)) {
    const result = await (options.security ?? security)(["find-generic-password", "-s", claudeKeychainService(root), "-a", claudeKeychainAccount(), "-w"]);
    if (result.code === 0) {
      try { if (Buffer.byteLength(result.stdout) <= 128_000) value = record(JSON.parse(result.stdout)); } catch { /* fixed error below */ }
      if (!value) throw new ClaudeCredentialError("credentials_unavailable");
    } else if (result.code !== 44) throw new ClaudeCredentialError("keychain_unavailable");
  }
  // Native Claude falls back to its config-local file when the exact service has no item.
  value ??= await privateJson(join(root, ".credentials.json"));
  const oauth = record(value?.claudeAiOauth);
  const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
  if (!token(oauth?.accessToken) || !token(oauth?.refreshToken)) throw new ClaudeCredentialError("credentials_unavailable");
  const config = await privateJson(join(root, ".claude.json"));
  const identity = record(config?.oauthAccount)?.accountUuid;
  if (typeof identity !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity))
    throw new ClaudeCredentialError("identity_invalid");
  return { access: oauth.accessToken, refresh: oauth.refreshToken, identity,
    digest: createHash("sha256").update(JSON.stringify(oauth)).digest("hex") };
}

/** Only the exact service reserved by this profile may be deleted. A failure leaves removal retryable. */
export async function removeClaudeCredentials(stateDir: string, id: string, options: ClaudeCredentialOptions = {}): Promise<void> {
  const root = claudeConfigRoot(stateDir, id);
  const marker = await privateJson(join(root, ".agentstack-profile.json"), true);
  if (!marker) return; // Preparation failed before a service was claimed; no native login could start.
  await ownedProfile(stateDir, id);
  if (!onMac(options)) return;
  const result = await (options.security ?? security)(["delete-generic-password", "-s", claudeKeychainService(root), "-a", claudeKeychainAccount()]);
  if (result.code !== 0 && result.code !== 44) throw new ClaudeCredentialError("keychain_unavailable");
}
