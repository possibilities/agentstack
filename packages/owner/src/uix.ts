import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

export function uixPort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.AGENTSTACK_UIX_PORT;
  const port = value === undefined ? 8745 : Number(value);
  if (value === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGENTSTACK_UIX_PORT must be an integer from 1 to 65535");
  }
  return port;
}

export function uixChild(port: number): OwnedChild {
  const cwd = dirname(require.resolve("@agentstack/uix/package.json"));
  return {
    name: "uix",
    command: process.execPath,
    args: [require.resolve("next/dist/bin/next", { paths: [cwd] }), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  };
}
