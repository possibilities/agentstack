import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkerProvider = "codex" | "grok" | "devin";
export type WorkerAccount = {
  id: string; provider: WorkerProvider; enabled: boolean; ready: boolean; removing: boolean;
};

export function accountRoot(stateDir: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid worker account ID");
  return join(stateDir, "worker-accounts", id);
}

export function accountEnvironment(stateDir: string, account: WorkerAccount, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = accountRoot(stateDir, account.id);
  const env = { ...source };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "XAI_API_KEY", "WINDSURF_API_KEY", "DEVIN_MODEL",
    "DEVIN_REFUSAL_FALLBACK", "OPENAI_BASE_URL", "OPENCODE_AUTH_CONTENT", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_DB", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
    "AGENTUSAGE_ACCOUNT", "AGENTUSAGE_AUTH_TOKEN"]) delete env[key];
  env.XDG_DATA_HOME = join(root, "data");
  env.XDG_CONFIG_HOME = account.provider === "devin" ? join(root, "config") : join(root, ".config");
  env.XDG_CACHE_HOME = join(root, "cache");
  if (account.provider !== "devin") {
    env.HOME = root;
    env.OPENCODE_CONFIG = join(root, ".config", "opencode", "opencode.json");
    env.OPENCODE_CONFIG_DIR = join(root, ".config", "opencode");
  }
  return env;
}

export async function prepareAccountProfile(stateDir: string, account: WorkerAccount): Promise<void> {
  const root = accountRoot(stateDir, account.id);
  for (const directory of [root, join(root, "data"), join(root, "config"), join(root, ".config"), join(root, "cache"), join(root, "probe")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  if (account.provider === "devin") {
    const dir = join(root, "config", "devin");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "config.json"), JSON.stringify({ read_config_from: {
      cursor: false, windsurf: false, claude: false, copilot: false, opencode: false, zed: false,
    } }), { mode: 0o600 });
  } else {
    const dir = join(root, ".config", "opencode");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const provider = account.provider === "grok" ? "xai" : "openai";
    await writeFile(join(dir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", update: "disable",
      experimental: { policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: provider, effect: "allow" },
      ] },
    }), { mode: 0o600 });
  }
}

export function loginCommand(stateDir: string, account: WorkerAccount): string {
  const env = accountEnvironment(stateDir, account, {});
  const assignments = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"]
    .flatMap((key) => env[key] ? [`${key}=${quote(env[key])}`] : []);
  const command = account.provider === "devin" ? "devin auth login"
    : `${quote(join(process.env.HOME ?? homedir(), ".local", "bin", "opencode"))} auth login --standalone ${account.provider === "grok" ? "xai" : "openai"}`;
  return `cd ${quote(join(accountRoot(stateDir, account.id), "probe"))} && umask 077 && env -u OPENAI_API_KEY -u CODEX_API_KEY -u CODEX_ACCESS_TOKEN -u XAI_API_KEY -u WINDSURF_API_KEY -u OPENAI_BASE_URL -u OPENCODE_AUTH_CONTENT -u OPENCODE_CONFIG_CONTENT -u OPENCODE_DB -u AGENTUSAGE_ACCOUNT -u AGENTUSAGE_AUTH_TOKEN ${assignments.join(" ")} ${command}`;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function credentialEvidence(stateDir: string, account: WorkerAccount): Promise<{ digest: string; identity: string | null }> {
  const root = accountRoot(stateDir, account.id);
  const path = account.provider === "devin" ? join(root, "data", "devin", "credentials.toml") : join(root, "data", "opencode", "opencode.db");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077))
    throw new Error("native worker credentials are not a private regular file");
  if (account.provider !== "devin") {
    const db = new DatabaseSync(path, { readOnly: true });
    let rows: Array<{ integration_id: string | null; value: string }>;
    try { rows = db.prepare("SELECT integration_id, value FROM credential").all() as typeof rows; }
    finally { db.close(); }
    const selected = account.provider === "grok" ? "xai" : "openai";
    if (rows.length !== 1 || rows[0]?.integration_id !== selected) throw new Error("native worker profile contains credentials for another provider");
    const value = JSON.parse(rows[0].value) as Record<string, unknown>;
    if (value.type !== "oauth" || typeof value.access !== "string" || !value.access ||
        typeof value.refresh !== "string" || !value.refresh) throw new Error("native worker OAuth credentials are unavailable");
    const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? value.metadata as Record<string, unknown> : null;
    return { digest: createHash("sha256").update(rows[0].value).digest("hex"),
      identity: typeof metadata?.accountID === "string" ? metadata.accountID : null };
  }
  const content = await readFile(path);
  if (content.length < 8 || content.length > 128_000) throw new Error("native Devin credentials are missing or invalid");
  const text = content.toString("utf8");
  if (!/^(?:windsurf_api_key|api_key)\s*=\s*["'][^"'\r\n]+["']\s*$/m.test(text) ||
      !/^api_server_url\s*=\s*["']https:\/\/[^"'\r\n]+["']\s*$/m.test(text))
    throw new Error("native Devin credentials are unavailable");
  return { digest: createHash("sha256").update(content).digest("hex"), identity: null };
}
