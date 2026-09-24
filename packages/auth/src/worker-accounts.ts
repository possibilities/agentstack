import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
    "DEVIN_REFUSAL_FALLBACK", "OPENAI_BASE_URL", "OPENCODE_AUTH_CONTENT", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
    "AGENTUSAGE_ACCOUNT", "AGENTUSAGE_AUTH_TOKEN"]) delete env[key];
  env.XDG_DATA_HOME = join(root, "data");
  env.XDG_CONFIG_HOME = join(root, "config");
  env.XDG_CACHE_HOME = join(root, "cache");
  if (account.provider !== "devin") {
    env.OPENCODE_CONFIG = join(root, "config", "opencode", "opencode.json");
    env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode");
  }
  return env;
}

export async function prepareAccountProfile(stateDir: string, account: WorkerAccount): Promise<void> {
  const root = accountRoot(stateDir, account.id);
  for (const directory of [root, join(root, "data"), join(root, "config"), join(root, "cache"), join(root, "probe")]) {
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
    const dir = join(root, "config", "opencode");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled",
      enabled_providers: [account.provider === "grok" ? "xai" : "openai"],
    }), { mode: 0o600 });
  }
}

export function loginCommand(stateDir: string, account: WorkerAccount): string {
  const env = accountEnvironment(stateDir, account, {});
  const assignments = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"]
    .flatMap((key) => env[key] ? [`${key}=${quote(env[key])}`] : []);
  const command = account.provider === "devin" ? "devin auth login"
    : `opencode auth login --provider ${account.provider === "grok" ? "xai" : "openai"}`;
  return `cd ${quote(join(accountRoot(stateDir, account.id), "probe"))} && env -u OPENAI_API_KEY -u XAI_API_KEY -u WINDSURF_API_KEY -u OPENCODE_AUTH_CONTENT -u OPENCODE_CONFIG_CONTENT ${assignments.join(" ")} ${command}`;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function credentialEvidence(stateDir: string, account: WorkerAccount): Promise<{ digest: string; identity: string | null }> {
  const root = accountRoot(stateDir, account.id);
  const path = account.provider === "devin" ? join(root, "data", "devin", "credentials.toml") : join(root, "data", "opencode", "auth.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || info.size > 128_000)
    throw new Error("native worker credentials are not a private regular file");
  const content = await readFile(path);
  if (content.length < 8 || content.length > 128_000) throw new Error("native worker credentials are missing or invalid");
  let identity: string | null = null;
  if (account.provider !== "devin") {
    const auth = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
    const selected = account.provider === "grok" ? "xai" : "openai";
    if (Object.keys(auth).length !== 1 || !Object.hasOwn(auth, selected)) throw new Error("native worker profile contains credentials for another provider");
    const provider = auth[selected];
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error("native worker sign-in did not provide the selected provider");
    const value = provider as Record<string, unknown>;
    if (value.type !== "oauth" || typeof value.access !== "string" || !value.access) throw new Error("native worker OAuth credentials are unavailable");
    identity = typeof value.accountId === "string" ? value.accountId : null;
  } else {
    const text = content.toString("utf8");
    if (!/^(?:windsurf_api_key|api_key)\s*=\s*["'][^"'\r\n]+["']\s*$/m.test(text) ||
        !/^api_server_url\s*=\s*["']https:\/\/[^"'\r\n]+["']\s*$/m.test(text))
      throw new Error("native Devin credentials are unavailable");
  }
  return { digest: createHash("sha256").update(content).digest("hex"), identity };
}
