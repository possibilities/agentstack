import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

export function botsChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "bots",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "bots", "socket"],
  };
}
