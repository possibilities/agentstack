import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedChild } from "./owner.js";

const require = createRequire(import.meta.url);

export function accessChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return { name: "access", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "access", "socket"] };
}

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
export function workerChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "worker", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "worker", "socket"],
  };
}
export function usageChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "usage", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "usage", "socket"],
  };
}
export function inferChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "infer", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "infer", "socket"],
  };
}
export function signalChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return { name: "signal", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "signal", "socket"] };
}
export function notifyChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return { name: "notify", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "notify", "socket"] };
}
export function contentChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "content", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "content", "socket"],
  };
}
export function brainChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "brain", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "brain", "socket"],
  };
}
export function xcomChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return { name: "xcom", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "xcom", "socket"] };
}
export function procChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "proc", command: process.execPath, parentFirst: true,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "proc", "socket"],
  };
}
export function scrapeChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "scrape", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "scrape", "socket"],
  };
}
export function browseChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return { name: "browse", command: process.execPath, parentFirst: true,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "browse", "socket"] };
}
export function websocketChild(): OwnedChild {
  return {
    name: "websocket",
    command: process.execPath,
    args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "websocket"],
  };
}
