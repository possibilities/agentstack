import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { serveApi, socketCall, socketPath, type ServedApi } from "../src/index.js";

type FixtureOptions = { prepare?: "absent" | "throw" | "reject"; failStart?: "context" | "events" };

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "as-lifecycle-"));
  const dir = join(root, "packages", "demo");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Lifecycle fixture.\nsocket:\n  description: Local socket.\n");
  const entry = join(dir, "dist", "api.js");
  await writeFile(entry, `
    import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
    export const state = { order: [], disposed: false, prepareOptions: null, closeOptions: null };
    const controller = new AbortController();
    let entered;
    export const started = new Promise((resolve) => { entered = resolve; });
    export let release;
    const gate = new Promise((resolve) => { release = resolve; });
    controller.signal.addEventListener("abort", () => release(), { once: true });
    export const api = {
      operations: [{
        name: "wait", description: "Wait until cancelled or released.", input: z.object({}),
        output: z.object({ aborted: z.boolean(), resourceOpen: z.boolean() }),
        async call(ctx) {
          ctx.order.push("call");
          entered();
          await gate;
          // A call still needs its context after cancellation while it unwinds.
          await new Promise((resolve) => setImmediate(resolve));
          ctx.order.push("settled");
          return { aborted: controller.signal.aborted, resourceOpen: !ctx.disposed };
        },
      }],
      events: {
        topics: { changed: "State changed." },
        start(ctx) {
          ctx.order.push("events-started");
          ${options.failStart === "events" ? 'throw new Error("events failed");' : ''}
          return () => { ctx.order.push("events-stopped"); };
        },
      },
      async createContext() {
        state.order.push("created");
        ${options.failStart === "context" ? 'throw new Error("context failed");' : ''}
        return state;
      },
      ${options.prepare === "absent" ? "" : `prepareCloseContext(ctx, options) {
        ctx.order.push("prepare");
        ctx.prepareOptions = options;
        controller.abort();
        ${options.prepare === "throw" ? 'throw new Error("prepare failed");' : options.prepare === "reject" ? 'return Promise.reject(new Error("prepare failed"));' : ""}
      },`}
      async closeContext(ctx, options) {
        ctx.order.push("dispose");
        ctx.closeOptions = options;
        ctx.disposed = true;
      },
    };
  `);
  const loaded = await import(pathToFileURL(entry).href) as {
    state: { order: string[]; disposed: boolean; prepareOptions: unknown; closeOptions: unknown };
    started: Promise<void>;
    release(): void;
  };
  const env = { AGENTSTACK_STATE_DIR: root };
  const path = socketPath("demo", env);
  let served: ServedApi | undefined;
  return {
    ...loaded, path,
    async start() { served = await serveApi({ name: "demo", transport: "socket", root, env }); return served; },
    async cleanup() {
      loaded.release();
      await served?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("prepareCloseContext cancels an active call before drain and disposes only after it settles", { timeout: 5_000 }, async () => {
  const setup = await fixture();
  try {
    const served = await setup.start();
    const call = socketCall(setup.path, "tools/call", { name: "wait", arguments: {} });
    await setup.started;
    const closing = served.close();
    assert.equal(served.close(), closing);
    const [result] = await Promise.all([call, closing]);
    assert.deepEqual(result, { aborted: true, resourceOpen: true });
    assert.deepEqual(setup.state.order, ["created", "events-started", "call", "events-stopped", "prepare", "settled", "dispose"]);
    assert.deepEqual(setup.state.prepareOptions, { halt: true });
    assert.deepEqual(setup.state.closeOptions, { halt: true });
    assert.equal(existsSync(setup.path), false);
    assert.equal(served.close(), closing);
  } finally {
    await setup.cleanup();
  }
});

for (const prepare of ["throw", "reject"] as const) {
  test(`a prepareCloseContext ${prepare} still drains calls and disposes context once`, { timeout: 5_000 }, async () => {
    const setup = await fixture({ prepare });
    try {
      const served = await setup.start();
      const call = socketCall(setup.path, "tools/call", { name: "wait", arguments: {} });
      await setup.started;
      const closing = served.close();
      assert.equal(served.close(), closing);
      const [result] = await Promise.all([call, assert.rejects(closing, /prepare failed/)]);
      assert.deepEqual(result, { aborted: true, resourceOpen: true });
      assert.deepEqual(setup.state.order, ["created", "events-started", "call", "events-stopped", "prepare", "settled", "dispose"]);
      assert.equal(setup.state.disposed, true);
      assert.equal(existsSync(setup.path), false);
      assert.equal(served.close(), closing);
    } finally {
      await setup.cleanup();
    }
  });
}

test("a package without prepareCloseContext keeps its context until calls drain", { timeout: 5_000 }, async () => {
  const setup = await fixture({ prepare: "absent" });
  try {
    const served = await setup.start();
    const call = socketCall(setup.path, "tools/call", { name: "wait", arguments: {} });
    await setup.started;
    const closing = served.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(setup.state.disposed, false);
    assert.deepEqual(setup.state.order, ["created", "events-started", "call", "events-stopped"]);
    setup.release();
    const [result] = await Promise.all([call, closing]);
    assert.deepEqual(result, { aborted: false, resourceOpen: true });
    assert.deepEqual(setup.state.order, ["created", "events-started", "call", "events-stopped", "settled", "dispose"]);
  } finally {
    await setup.cleanup();
  }
});

test("startup failure prepares and disposes a created context even when preparation fails", { timeout: 5_000 }, async () => {
  const setup = await fixture({ failStart: "events", prepare: "throw" });
  try {
    await assert.rejects(setup.start(), /events failed/);
    assert.deepEqual(setup.state.order, ["created", "events-started", "prepare", "dispose"]);
    assert.deepEqual(setup.state.prepareOptions, { halt: true });
    assert.deepEqual(setup.state.closeOptions, { halt: true });
    assert.equal(existsSync(setup.path), false);
  } finally {
    await setup.cleanup();
  }
});

test("failed context creation closes the socket without invoking context cleanup hooks", { timeout: 5_000 }, async () => {
  const setup = await fixture({ failStart: "context" });
  try {
    await assert.rejects(setup.start(), /context failed/);
    assert.deepEqual(setup.state.order, ["created"]);
    assert.equal(existsSync(setup.path), false);
  } finally {
    await setup.cleanup();
  }
});
