import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveApi } from "@stack/api";
import { startServer } from "../../dist/src/server.js";
import { statusSource } from "../../dist/src/status.js";
import { factoryLifecycle } from "../../dist/src/factory-lifecycle.js";
import { authChild, rolesChild, browseChild, workerChild, contentChild, sourceChild } from "../../dist/src/children.js";
import { botsChild } from "../../dist/src/bots.js";

const events = await serveApi({ name: "serve", transport: "socket", env: process.env });
const real = [authChild(), rolesChild(), browseChild(), workerChild(), contentChild(), sourceChild(), botsChild()];
const inert = ["access", "websocket", "inspector", "ui", "proc", "signal", "infer", "hud", "usage", "brain", "xcom", "scrape", "notify", "api"];
const dummy = name => ({ name, command: process.execPath, args: ["-e", `process.on('disconnect',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(${process.env.FACTORY_FAIL_OWNER === name ? 1 : 0}));setInterval(()=>{},1000)`] });
const server = startServer([...real, ...inert.map(dummy)], process.env);
statusSource.attach(server);
const lifecycle = factoryLifecycle(process.env, server, async () => {
  if (process.env.FACTORY_CRASH === "yes") process.exit(1);
  if (process.env.FACTORY_DRAIN_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FACTORY_DRAIN_DELAY)));
  await server.stop(["access", "websocket"], { graceful: true });
  await server.stop(["inspector", "ui"]);
  await events.close();
}, failed => { void server.close().then(() => process.exit(failed ? 1 : 0)); });
statusSource.factoryReset = { ...lifecycle, async cleanup(...args) {
  // Observe the real process boundary before any retained storage is removed.
  const source = server.children().find(child => child.name === "source");
  assert.equal(source.running, false, "source must stop before installation cleanup");
  assert.equal(source.exitCode, 0, "source must confirm a clean exit");
  assert.ok(existsSync(join(process.env.STACK_STATE_DIR, "github", "github.sqlite")));
  await lifecycle.cleanup(...args);
} };
process.on("SIGTERM", () => { void events.close().then(() => server.close()).then(() => process.exit(0)); });
process.send?.({ ready: true });
