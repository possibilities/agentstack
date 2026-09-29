import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedChild } from "./server.js";

const require = createRequire(import.meta.url);

export function uiPort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.AGENTSTACK_UI_PORT;
  const port = value === undefined ? 8745 : Number(value);
  if (value === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGENTSTACK_UI_PORT must be an integer from 1 to 65535");
  }
  return port;
}

export function uiChild(port: number): OwnedChild {
  const cwd = dirname(require.resolve("@agentstack/ui/package.json"));
  return {
    name: "ui",
    command: process.execPath,
    args: [fileURLToPath(new URL("./guarded-server.js", import.meta.url)), process.execPath,
      require.resolve("next/dist/bin/next", { paths: [cwd] }), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  };
}
