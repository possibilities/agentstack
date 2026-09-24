import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

export function codexChild(ownerMcpPort?: number): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "codex",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "codex", "socket"],
    ...(ownerMcpPort === undefined ? {} : { env: { AGENTSTACK_OWNER_MCP_PORT: String(ownerMcpPort) } }),
  };
}
