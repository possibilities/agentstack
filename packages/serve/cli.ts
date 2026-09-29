import type { PackageCli } from "@stack/cli";
import { runServeCommand } from "./src/cli.js";

export default {
  run(args) { return runServeCommand(args[0] ?? "serve", args.slice(1)); },
} satisfies PackageCli;
