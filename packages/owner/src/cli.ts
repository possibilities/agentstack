#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { codexChild } from "./codex.js";
import { startOwner } from "./owner.js";
import { launchThroughPortless, uiOrigin } from "./portless.js";
import { startUiServer } from "./ui.js";

const require = createRequire(import.meta.url);

if (process.argv[2] !== "serve") {
  console.error("usage: agentstack serve");
  process.exit(1);
}

if (!process.argv.includes("--direct")) {
  try {
    process.exit(await launchThroughPortless(fileURLToPath(import.meta.url)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.env.PORTLESS_URL !== uiOrigin || !Number.isInteger(Number(process.env.PORT))) {
  console.error("agentstack serve must run through portless at https://agentstack.localhost.");
  process.exit(1);
}

const children = [codexChild()];
const owner = startOwner(children);
const ownerPackage = require.resolve("./../../package.json");
const ownerManifest = JSON.parse(readFileSync(ownerPackage, "utf8")) as { agentstack?: { ui?: string } };
const ownerUi = ownerManifest.agentstack?.ui;
if (!ownerUi) throw new Error("@agentstack/owner does not export a UI");
const ui = await startUiServer(
  [
    {
      name: "owner",
      dir: join(dirname(ownerPackage), ownerUi),
      data: () => ({ children: owner.children() }),
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
  Number(process.env.PORT),
);
console.error(`${uiOrigin}/_ui/owner`);
console.error(`${uiOrigin}/_ui/codex`);

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
