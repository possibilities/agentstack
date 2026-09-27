import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { stateDir } from "@agentstack/api";

const require = createRequire(import.meta.url);

/** Generate one private provider config; do not change the global AgentStart config. */
export function prepareBrowserConfig(env: NodeJS.ProcessEnv): string {
  const packageJson = require.resolve("@agentstack/browser/package.json");
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
