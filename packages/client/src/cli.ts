#!/usr/bin/env node
import { socketCall } from "@stack/api";
import { startClientHost } from "./host.js";
import { clientInputs } from "./contract.js";
import { join } from "node:path";
import { homedir } from "node:os";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "serve" && (!args.length || args.length === 2 && args[0] === "--ui-origin")) {
    const host = await startClientHost({ ...(args.length ? { uiOrigin: args[1] } : {}) });
    // The private socket path is not a credential. Native/UI parents use socketCall.
    console.log(JSON.stringify({ schema_version: 1, ok: true, data: { socket: host.path } }));
    let closing = false;
    const close = () => { if (closing) return; closing = true; void host.close().then(() => process.exit(0), () => process.exit(1)); };
    process.on("SIGTERM", close); process.on("SIGINT", close);
  } else if (command === "call" && args.length >= 1 && args.length <= 2 && args[0]! in clientInputs) {
    const root = process.env.STACK_CLIENT_STATE_DIR ?? join(homedir(), ".local", "share", "stack-client");
    const data = await socketCall(join(root, "client.sock"), "tools/call", { name: args[0], arguments: JSON.parse(args[1] ?? "{}") });
    console.log(JSON.stringify({ schema_version: 1, ok: true, data }));
  } else throw new Error("usage: stack-client serve [--ui-origin http://127.0.0.1:PORT] | stack-client call <operation> [json]");
} catch (error) {
  const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : "client_command_failed";
  console.error(JSON.stringify({ schema_version: 1, ok: false, error: { code } })); process.exitCode = 1;
}
