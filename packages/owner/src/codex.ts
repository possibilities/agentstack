import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

export function codexChild(): OwnedChild {
  const packageJsonPath = require.resolve("@agentstack/codex/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: Record<string, string> };
  const relativeBin = pkg.bin?.["agentstack-codex"];
  if (!relativeBin) throw new Error("@agentstack/codex is missing its bin");
  return {
    name: "codex",
    command: process.execPath,
    args: [join(dirname(packageJsonPath), relativeBin), "serve"],
  };
}
