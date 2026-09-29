import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { botInstance, operation, serveApi, serveSocket, socketCall, socketPath, type InvocationContext } from "@stack/api";
import { resolveWorkContext } from "../src/client.js";
import type { Focus, WorkContext, WorkItem } from "../src/schema.js";

test("verified Chat focus inherits only sanctioned ancestry and captures explicit clearing, closure and launch fences", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-hud-context-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(native, "listening");
  const main = randomUUID(), child = randomUUID(), outsider = randomUUID();
  const url = `ws://127.0.0.1:${(native.address() as { port: number }).port}`;
  let mainThreadId = main;
  native.on("connection", socket => socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.id === undefined) return;
    const result = frame.method === "thread/loaded/list" ? { data: [main, child, outsider] }
      : frame.method === "thread/read" ? { thread: { id: frame.params.threadId, status: { type: "active" }, parentThreadId: frame.params.threadId === child ? main : null } }
      : {};
    socket.send(JSON.stringify({ id: frame.id, result }));
  }));
  const bots = await serveSocket({ info: { name: "bots", description: "Fixture", transportDescription: "Socket", path: socketPath("bots", env) }, context: {},
    operations: [operation({ name: "bot_list", description: "Native launch inventory", input: z.object({}), output: z.any(),
      async call() { return { bots: [{ id: "bot-1", state: "running", url, mainThreadId, recoveryIssue: null }] }; } })] });
  const hud = await serveApi({ name: "hud", transport: "socket", env });
  const invocation: InvocationContext = { transport: "mcp", botId: "bot-1", instance: botInstance(url), threadId: main, sessionId: null };
  const call = <T>(name: string, args: object, caller: InvocationContext = invocation) => socketCall(hud.socketPath!, "tools/call", { name, arguments: args, invocation: caller }) as Promise<T>;
  const id = randomUUID(), other = randomUUID();
  try {
    await call("work_create", { requestId: randomUUID(), id, title: "Current work", objective: "Follow exact context", state: "active" });
    await call("work_create", { requestId: randomUUID(), id: other, title: "Other work", objective: "An independent objective" });
    const item = await call<WorkItem>("work_get", { id });
    assert.deepEqual(item.createdBy, { kind: "bot", botId: "bot-1", mainThreadId: main, threadId: main });
    assert.deepEqual(item.links[0]!.target, { kind: "chat", botId: "bot-1", mainThreadId: main, threadId: main });
    assert.equal((await call<Focus>("work_focus_get", {})).revision, 0);
    assert.equal(await resolveWorkContext(env, undefined, invocation), null, "creation records origin but does not select arbitrary focus");
    const selected = { requestId: randomUUID(), expectedRevision: 0, workItemId: id };
    await call("work_focus_set", selected);
    const descendant = { ...invocation, threadId: child };
    assert.deepEqual(await resolveWorkContext(env, undefined, descendant), { workItemId: id, scopeRevision: 1, source: "focus" });
    assert.deepEqual(await resolveWorkContext(env, other, descendant), { workItemId: other, scopeRevision: 1, source: "explicit" });
    await call("work_focus_set", { requestId: randomUUID(), expectedRevision: 0, workItemId: null }, descendant);
    assert.equal(await resolveWorkContext(env, undefined, descendant), null, "a saved null is an inheritance barrier");
    await assert.rejects(call("work_focus_set", { requestId: randomUUID(), expectedRevision: 1, workItemId: other,
      target: { botId: "bot-1", mainThreadId: main, threadId: main } }, descendant), /hud_focus_owner/);
    await assert.rejects(call("work_get", { id }, { ...invocation, threadId: outsider }), /outside the sanctioned lineage/);
    await assert.rejects(call("work_create", { requestId: randomUUID(), id: randomUUID(), title: "Spoof", objective: "No forged actors", actor: { kind: "operator" } }), /Unrecognized key/);
    await assert.rejects(call("work_get", { id }, { ...invocation, botId: null, workerId: randomUUID(), workerInstance: randomUUID() }), /hud_caller_unverified/);
    await call("work_update", { requestId: randomUUID(), id, expectedRevision: 1, patch: { objective: "Revised objective" } });
    const continued = await resolveWorkContext(env, undefined, invocation, { workItemId: id, scopeRevision: 1, source: "focus" });
    assert.deepEqual(continued, { workItemId: id, scopeRevision: 2, source: "continuation" });
    await call("work_update", { requestId: randomUUID(), id, expectedRevision: 2, patch: { state: "completed" } });
    await assert.rejects(resolveWorkContext(env, undefined, invocation), /work_closed/);
    assert.equal(await resolveWorkContext(env, null, invocation), null, "explicit opt-out needs no automatic association");
    await call("work_focus_set", { requestId: randomUUID(), expectedRevision: 1, workItemId: other });
    assert.equal((await call<{ duplicate: boolean }>("work_focus_set", selected)).duplicate, true, "retry does not restore an old focus");
    assert.equal((await call<Focus>("work_focus_get", {})).workItemId, other);
    mainThreadId = outsider;
    await assert.rejects(resolveWorkContext(env, undefined, invocation), /outside the sanctioned lineage/);
    const replacement = { ...invocation, threadId: outsider };
    assert.equal((await call<Focus>("work_focus_get", {}, replacement)).revision, 0, "Bot ID reuse cannot inherit a retired root's focus");
    assert.equal((await call<{ context: WorkContext | null }>("work_context_resolve", {}, replacement)).context, null);
    await assert.rejects(call("work_get", { id }, { ...replacement, instance: "retired-launch" }), /launch changed/);
  } finally {
    await hud.close(); await bots.close();
    for (const socket of native.clients) socket.terminate();
    await new Promise<void>(resolve => native.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
