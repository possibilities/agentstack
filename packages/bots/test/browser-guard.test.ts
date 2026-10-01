import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { operation, serveSocket, socketPath } from "@stack/api";
import { api } from "../api.js";
import type { StoredServer } from "../src/store.js";

test("Browser maintenance holds the stopped Bot lifecycle mutex through owner callback and never starts a process", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-browser-bot-guard-")), env = { ...process.env, STACK_STATE_DIR: root }, ctx = await api.createContext!(env);
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
  const browser = await serveSocket({ info: { name: "browse", description: "Callback fixture", transportDescription: "Socket", path: socketPath("browse", env) }, context: {}, operations: [operation({ name: "browse_state_bot_effect", description: "Owner callback transport fixture", input: z.strictObject({ botId: z.string(), profileId: z.uuid(), token: z.uuid() }), output: z.record(z.string(), z.unknown()),
    async call() { entered(); await proceed; return { revision: "observed-by-browser" }; } })] });
  try {
    const record: StoredServer = { id: "bot-1", pid: null, cwd: root, url: null, state: "stopped", codexBin: "never-launched", account: null, launchedAccount: null, authVersion: null, runtimeRoot: null, mainThreadId: null, threadStarting: false, args: [] };
    ctx.store.saveServer(record); await ctx.supervisor.load();
    const op = api.operations.find(row => row.name === "bot_state_browser_guard")!, args = { botId: record.id, profileId: randomUUID(), token: randomUUID() };
    await assert.rejects(op.call(ctx, op.input.parse(args), { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /operator authority/);
    const guarded = op.call(ctx, op.input.parse(args)); await entering;
    let mutated = false; const later = ctx.supervisor.mutateResource(record.id, async () => { mutated = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(mutated, false);
    release(); assert.equal((await guarded as Record<string, unknown>).revision, "observed-by-browser"); await later; assert.equal(mutated, true);
    assert.equal(ctx.supervisor.list()[0]!.state, "stopped"); assert.equal(ctx.supervisor.list()[0]!.pid, null);
  } finally { release(); await browser.close(); await api.closeContext!(ctx); await rm(root, { recursive: true, force: true }); }
});
