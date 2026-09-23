#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loadCatalog, runApi } from "@agentstack/api";
import { codexChild } from "./codex.js";
import { startOwner } from "./owner.js";
import { startUiServer, uiListenPort, uiPageUrl } from "./ui.js";

const require = createRequire(import.meta.url);
const command = process.argv[2];

if (command === "api") {
  await runApi(process.argv.slice(3));
} else if (command !== "serve") {
  console.error("usage: agentstack serve\nusage: agentstack api <package> <transport>");
  process.exit(1);
}

let port: number;
try {
  port = uiListenPort();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const children = [codexChild()];
const owner = startOwner(children);
const ownerPackage = require.resolve("./../../package.json");
const ownerManifest = JSON.parse(readFileSync(ownerPackage, "utf8")) as { agentstack?: { ui?: string } };
const ownerUi = ownerManifest.agentstack?.ui;
if (!ownerUi) throw new Error("@agentstack/owner does not export a UI");
const apiPackage = require.resolve("@agentstack/api/package.json");
const apiManifest = JSON.parse(readFileSync(apiPackage, "utf8")) as { agentstack?: { ui?: string } };
const apiUi = apiManifest.agentstack?.ui;
if (!apiUi) throw new Error("@agentstack/api does not export a UI");

let ui: Awaited<ReturnType<typeof startUiServer>>;
try {
  ui = await startUiServer(
    [
      {
        name: "owner",
        dir: join(dirname(ownerPackage), ownerUi),
        data: () => ({ pid: process.pid, children: owner.children() }),
      },
      {
        name: "api",
        dir: join(dirname(apiPackage), apiUi),
        data: () => loadCatalog(),
      },
      ...children.flatMap((child) =>
        child.uiDir && child.dataUrl
          ? [
              {
                name: child.name,
                dir: child.uiDir,
                data: async (request: URL | undefined) => {
                  const target = new URL(child.dataUrl ?? "");
                  if (request) target.search = request.search;
                  const response = await fetch(target);
                  if (!response.ok) throw new Error(`${child.name} UI data unavailable`);
                  return response.json();
                },
              },
            ]
          : [],
      ),
    ],
    port,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await owner.close();
  process.exit(1);
}

console.error(uiPageUrl(ui.port, "owner"));
console.error(uiPageUrl(ui.port, "codex"));
console.error(uiPageUrl(ui.port, "api"));

let closing = false;
const shutdown = () => {
  if (closing) process.exit(1);
  closing = true;
  const force = setTimeout(() => process.exit(1), 3_000);
  force.unref();
  void ui
    .close()
    .then(() => owner.close())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
