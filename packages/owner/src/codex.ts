import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

type PackageManifest = {
  agentstack?: { ui?: string };
};

export function codexChild(env: NodeJS.ProcessEnv = process.env): OwnedChild {
  const packageJsonPath = require.resolve("@agentstack/codex/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
  const apiPackage = require.resolve("@agentstack/api/package.json");
  const root = dirname(packageJsonPath);
  const port = env.AGENTSTACK_PORT || "39231";
  return {
    name: "codex",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "codex", "socket"],
    env: { AGENTSTACK_PORT: port },
    uiDir: pkg.agentstack?.ui ? join(root, pkg.agentstack.ui) : undefined,
    dataUrl: `http://127.0.0.1:${port}/ui-data`,
  };
}
