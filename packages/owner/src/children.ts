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
export function inferChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return {
    name: "infer", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "infer", "socket"],
  };
}
export function attentionChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return { name: "attention", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "attention", "socket"] };
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
export function browserChild(): OwnedChild {
  const apiPackage = require.resolve("@agentstack/api/package.json");
  return { name: "browser", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "cli.js"), "browser", "socket"] };
}
export function websocketChild(): OwnedChild {
  return {
    name: "websocket",
    command: process.execPath,
    args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "websocket"],
  };
}
