import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const directory = process.cwd();
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
if (!["@agentstack/access", "@agentstack/api", "@agentstack/attention", "@agentstack/auth", "@agentstack/bots", "@agentstack/browser", "@agentstack/roles", "@agentstack/owner", "@agentstack/workers", "@agentstack/usage", "@agentstack/infer", "@agentstack/content", "@agentstack/brain", "@agentstack/notify"].includes(manifest.name)) {
  throw new Error(`refusing to clean dist outside an AgentStack package: ${directory}`);
}
await rm(join(directory, "dist"), { recursive: true, force: true });
