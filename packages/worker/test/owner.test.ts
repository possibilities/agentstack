import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botInstance, operation, serveSocket, socketPath, type InvocationContext } from "@agentstack/api";
import { z } from "zod";
import { LOCAL_OPERATOR_ID, workerOwner } from "../src/owner.js";

test("Worker targets recognize operator schedules and fence scheduled Bot roots and instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-worker-owner-"));
  const env = { AGENTSTACK_STATE_DIR: root };
  const bot = { id: "a", state: "running", url: "unix:///fixture-launch", mainThreadId: "new-root", recoveryIssue: null };
  const served = await serveSocket({ info: { name: "bots", description: "Bots", transportDescription: "Socket", path: socketPath("bots", env) }, context: {},
    operations: [operation({ name: "bot_list", description: "List", input: z.object({}), output: z.any(), async call() { return { bots: [bot] }; } })] });
  const invocation: InvocationContext = { transport: "proc", scheduleId: "00000000-0000-4000-8000-000000000001", executionId: "00000000-0000-4000-8000-000000000002",
    authority: { kind: "operator" }, botId: null, instance: null, threadId: null, sessionId: null };
  try {
    assert.deepEqual(await workerOwner(invocation, env), { botId: LOCAL_OPERATOR_ID, threadId: LOCAL_OPERATOR_ID });
    const scheduled: InvocationContext = { ...invocation, authority: { kind: "bot", botId: "a", mainThreadId: "old-root", threadId: "child" },
      botId: "a", instance: botInstance(bot.url), threadId: "child" };
    await assert.rejects(workerOwner(scheduled, env), /root changed/);
    await assert.rejects(workerOwner({ ...scheduled, instance: "old-instance" }, env), /not verified/);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});
