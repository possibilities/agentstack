import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const directory = process.cwd();
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
if (!["@agentstack/api", "@agentstack/auth", "@agentstack/bots", "@agentstack/codex", "@agentstack/docs", "@agentstack/owner"].includes(manifest.name)) {
  throw new Error(`refusing to clean dist outside an AgentStack package: ${directory}`);
}
await rm(join(directory, "dist"), { recursive: true, force: true });
