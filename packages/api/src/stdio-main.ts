import { runMcpStdio } from "./stdio.js";

// Never re-export this executable module: declarations importing @stack/api
// must not await their own gateway's connection lifetime during module loading.
try {
  if (process.argv.length !== 3) throw new Error("usage: stack serve mcp <name> --stdio");
  await runMcpStdio(process.argv[2]!);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
