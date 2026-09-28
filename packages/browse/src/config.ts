import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { stateDir, botInstance, botMcpUrl } from "@agentstack/api";

const require = createRequire(import.meta.url);

export function browserNamespace(env: NodeJS.ProcessEnv, botId: string, instance: string): string {
  return `ast-${createHash("sha256").update(`${stateDir(env)}\0${botId}\0${instance}`).digest("hex").slice(0, 24)}`;
}

/** Private launch proof, not the arbitrary controller session, establishes Bot scope. */
export function prepareBotBrowserConfig(env: NodeJS.ProcessEnv, botId: string, endpoint: string): string {
  const instance = botInstance(endpoint);
  const namespace = browserNamespace(env, botId, instance);
  const entry = join(dirname(require.resolve("@agentstack/browse/package.json")), "dist", "src", "provider.js");
  const path = join(stateDir(env), "browser", "controllers", namespace + ".json");
  const identity = botMcpUrl("http://127.0.0.1/browser-identity", botId, endpoint, env);
  const content = JSON.stringify({ provider: "agentstack", namespace, idleTimeout: "0", plugins: [{ name: "agentstack", command: process.execPath,
    args: [entry, identity], capabilities: ["browser.provider"] }] }) + "\n";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const temp = `${path}.${process.pid}.tmp`;
    try { writeFileSync(temp, content, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  } else if (readFileSync(path, "utf8") !== content) throw new Error("Bot browser launch configuration changed");
  return path;
}

/** Generate one private provider config; do not change the global AgentStart config. */
export function prepareBrowserConfig(env: NodeJS.ProcessEnv): string {
  const packageJson = require.resolve("@agentstack/browse/package.json");
  const entry = join(dirname(packageJson), "dist", "src", "provider.js");
  const path = join(stateDir(env), "browser", "agent-browser.json");
  const content = `${JSON.stringify({ provider: "agentstack", plugins: [{
    name: "agentstack", command: process.execPath, args: [entry], capabilities: ["browser.provider"],
  }] }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) throw new Error(`AgentStack browser config differs from the managed provider: ${path}`);
  } else {
    const temp = `${path}.${process.pid}.tmp`;
    try { writeFileSync(temp, content, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  return path;
}
