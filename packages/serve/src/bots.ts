import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OwnedChild } from "./server.js";

const require = createRequire(import.meta.url);

export function botsChild(serverMcpPort?: number): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "bots",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "bots", "socket"],
    ...(serverMcpPort === undefined ? {} : { env: { STACK_SERVER_MCP_PORT: String(serverMcpPort) } }),
  };
}
