import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

export function apiChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "api",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "api", "socket"],
  };
}

export function authChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "auth",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "auth", "socket"],
  };
}
export function rolesChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "roles",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "roles", "socket"],
  };
}
export function workersChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "workers", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "workers", "socket"],
  };
}
export function usageChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "usage", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "usage", "socket"],
  };
}
export function websocketChild(): OwnedChild {
  return {
    name: "websocket",
    command: process.execPath,
    args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "websocket"],
  };
}
