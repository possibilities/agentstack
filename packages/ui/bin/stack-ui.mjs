#!/usr/bin/env node
import { startClientUi } from "./launcher.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("stack-ui [--root /absolute/client/root] [--port 19000] [--release-manifest /absolute/reviewed-release.json] [--no-open]\nIndependent Client UI; closing it never stops the platform. Node >=24 and a built UI are required. Install requires a reviewed pinned release manifest (--release-manifest or STACK_CLIENT_RELEASE_MANIFEST).");
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGHUP", () => controller.abort());
  try {
    const options = { signal: controller.signal };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--no-open") options.open = false;
      else if (args[i] === "--root" && args[i + 1]) options.root = args[++i];
      else if (args[i] === "--release-manifest" && args[i + 1]) options.releaseManifest = args[++i];
      else if (args[i] === "--port" && /^\d+$/.test(args[i + 1] ?? "")) options.port = Number(args[++i]);
      else throw new Error("invalid_arguments");
    }
    const client = await startClientUi(options);
    console.log(`Stack Client UI ready at ${client.origin}/client. Closing this launcher leaves the platform running.`);
    await client.closed;
  } catch (error) {
    // Never print raw errors from sockets, Next, bootstrap or native navigation.
    const code = error instanceof Error && /^[a-z][a-z0-9_]{1,79}$/.test(error.message) ? error.message : "client_ui_failed";
    console.error(`Stack Client UI: ${code}. No platform service was stopped.`);
    process.exitCode = 1;
  }
}
