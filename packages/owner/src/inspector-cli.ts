#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const config = process.argv[2];
if (!config) throw new Error("Inspector catalog path is required");
const packageRoot = dirname(require.resolve("@modelcontextprotocol/inspector/package.json"));
const inspector = spawn(process.execPath, [join(packageRoot, "clients", "launcher", "build", "index.js"), "--web", "--config", config], {
  env: process.env,
  stdio: ["ignore", "ignore", "inherit"],
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  inspector.kill("SIGTERM");
  const force = setTimeout(() => inspector.kill("SIGKILL"), 10_000);
  force.unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("disconnect", stop);
inspector.once("error", (error) => {
  console.error(`Inspector failed to start: ${error.message}`);
  process.exit(1);
});
inspector.once("exit", (code) => process.exit(stopping ? 0 : (code ?? 1)));
