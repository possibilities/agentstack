import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { stateDir, botInstance, botMcpUrl } from "@stack/api";

const require = createRequire(import.meta.url);

export function browserNamespace(env: NodeJS.ProcessEnv, botId: string, instance: string): string {
  return `ast-${createHash("sha256").update(`${stateDir(env)}\0${botId}\0${instance}`).digest("hex").slice(0, 24)}`;
}

/** Private launch proof, not the arbitrary controller session, establishes Bot scope. */
export function prepareBotBrowserConfig(env: NodeJS.ProcessEnv, botId: string, endpoint: string): string {
  const instance = botInstance(endpoint);
  const namespace = browserNamespace(env, botId, instance);
  const entry = join(dirname(require.resolve("@stack/browse/package.json")), "dist", "src", "provider.js");
  const path = join(stateDir(env), "browser", "controllers", namespace + ".json");
  const identity = botMcpUrl("http://127.0.0.1/browser-identity", botId, endpoint, env);
  const content = JSON.stringify({ provider: "stack", namespace, idleTimeout: "0", plugins: [{ name: "stack", command: process.execPath,
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
  const packageJson = require.resolve("@stack/browse/package.json");
  const entry = join(dirname(packageJson), "dist", "src", "provider.js");
  const path = join(stateDir(env), "browser", "agent-browser.json");
  const content = `${JSON.stringify({ provider: "stack", plugins: [{
    name: "stack", command: process.execPath, args: [entry], capabilities: ["browser.provider"],
  }] }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const previous = readFileSync(path, "utf8");
    if (previous !== content) {
      let legacy: unknown;
      try { legacy = JSON.parse(previous); } catch { /* preserve unknown configuration */ }
      const old = legacy as { provider?: unknown; plugins?: unknown } | undefined;
      const plugin = Array.isArray(old?.plugins) && old.plugins.length === 1 ? old.plugins[0] as Record<string, unknown> : null;
      const args = plugin?.args;
      const node = plugin?.command;
      const managedNode = node === process.execPath || (typeof node === "string" &&
        /^\/Users\/[^/]+\/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin\/node$/.test(node));
      const managed = old?.provider === "agentstack" && plugin?.name === "agentstack" &&
        managedNode && Array.isArray(args) && args.length === 1 &&
        typeof args[0] === "string" && /\/code\/agentstack\/packages\/(browse|browser)\/dist\/src\/provider\.js$/.test(args[0]) &&
        JSON.stringify(plugin.capabilities) === JSON.stringify(["browser.provider"]);
      if (!managed) throw new Error(`Stack browser config differs from the managed provider: ${path}`);
      const temp = `${path}.${process.pid}.tmp`;
      try { writeFileSync(temp, content, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
      finally { rmSync(temp, { force: true }); }
    }
  } else {
    const temp = `${path}.${process.pid}.tmp`;
    try { writeFileSync(temp, content, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  return path;
}
