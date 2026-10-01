import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedChild } from "./server.js";

const require = createRequire(import.meta.url);

export function accessChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return { name: "access", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "access", "socket"] };
}

export function apiChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "api",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "api", "socket"],
  };
}

export function authChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "auth",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "auth", "socket"],
  };
}
export function rolesChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "roles",
    command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "roles", "socket"],
  };
}
export function workerChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "worker", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "worker", "socket"],
  };
}
export function usageChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "usage", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "usage", "socket"],
  };
}
export function inferChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "infer", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "infer", "socket"],
  };
}
export function signalChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return { name: "signal", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "signal", "socket"] };
}
export function notifyChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return { name: "notify", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "notify", "socket"] };
}
export function hudChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return { name: "hud", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "hud", "socket"] };
}
export function contentChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "content", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "content", "socket"],
  };
}
export function brainChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "brain", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "brain", "socket"],
  };
}
export function xcomChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return { name: "xcom", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "xcom", "socket"] };
}
export function sourceChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return { name: "source", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "source", "socket"] };
}
export function procChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "proc", command: process.execPath, parentFirst: true,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "proc", "socket"],
  };
}
export function scrapeChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return {
    name: "scrape", command: process.execPath,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "scrape", "socket"],
  };
}
export function browseChild(): OwnedChild {
  const apiPackage = require.resolve("@stack/api/package.json");
  return { name: "browse", command: process.execPath, parentFirst: true,
    args: [join(dirname(apiPackage), "dist", "src", "transport-main.js"), "browse", "socket"] };
}
export function websocketChild(): OwnedChild {
  return {
    name: "websocket",
    command: process.execPath,
    args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "websocket"],
  };
}
