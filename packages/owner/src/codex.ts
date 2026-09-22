import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

type PackageManifest = {
  bin?: Record<string, string>;
  agentstack?: { ui?: string };
};

export function codexChild(env: NodeJS.ProcessEnv = process.env): OwnedChild {
  const packageJsonPath = require.resolve("@agentstack/codex/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
  const relativeBin = pkg.bin?.["agentstack-codex"];
  if (!relativeBin) throw new Error("@agentstack/codex is missing its bin");
  const root = dirname(packageJsonPath);
  const port = env.AGENTSTACK_PORT || "39231";
  return {
    name: "codex",
    command: process.execPath,
    args: [join(root, relativeBin), "serve"],
    env: { AGENTSTACK_PORT: port },
    uiDir: pkg.agentstack?.ui ? join(root, pkg.agentstack.ui) : undefined,
    dataUrl: `http://127.0.0.1:${port}/ui-data`,
  };
}
