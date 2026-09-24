import { fileURLToPath } from "node:url";
import type { OwnedChild } from "./owner.js";

export function inspectorPort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.AGENTSTACK_INSPECTOR_PORT;
  const port = value === undefined ? 6274 : Number(value);
  if (value === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGENTSTACK_INSPECTOR_PORT must be an integer from 1 to 65535");
  }
  return port;
}

export function inspectorChild(configPath: string, port: number): OwnedChild {
  return {
    name: "inspector",
    command: process.execPath,
    args: [fileURLToPath(new URL("./inspector-cli.js", import.meta.url)), configPath],
    env: {
      CLIENT_PORT: String(port),
      HOST: "127.0.0.1",
      ALLOWED_ORIGINS: "",
      MCP_CATALOG_PATH: "",
      MCP_AUTO_OPEN_ENABLED: "false",
      MCP_SANDBOX_PORT: "0",
      MCP_APP_ORIGIN_PORT: "0",
      DANGEROUSLY_BIND_ALL_INTERFACES: "false",
      DANGEROUSLY_OMIT_AUTH: "false",
    },
  };
}
