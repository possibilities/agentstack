import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpProcess, record } from "../src/acp.js";
import { effortOption, modelOption, optionsOf } from "../src/catalog.js";

test("installed Grok/OpenCode V2 and native Devin ACP complete bounded text turns", {
  skip: process.env.AGENTSTACK_NATIVE_WORKER_TURN !== "1", timeout: 180_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-native-worker-turn-"));
  try {
    const opencodeV2 = join(homedir(), ".local", "bin", "opencode");
    const devinNative = join(homedir(), ".local", "share", "devin", "cli", "_versions", "current", "bin", "devin");
    for (const harness of ["grok", "devin"] as const) {
      const child = new AcpProcess(harness === "grok" ? opencodeV2 : devinNative, ["acp"], cwd, process.env);
      const streamed: string[] = [];
      child.onNotification = (method, params) => {
        if (method !== "session/update" || !record(params) || !record(params.update)) return;
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" && record(update.content) && typeof update.content.text === "string") streamed.push(update.content.text);
      };
      child.onRequest = (request) => {
        if (request.method !== "session/request_permission") return false;
        queueMicrotask(() => child.respondRequest(request.id, { outcome: { outcome: "cancelled" } }));
        return true;
      };
      try {
        await child.initialize();
        const created = await child.request("session/new", { cwd, mcpServers: [] }, 45_000);
        assert.ok(record(created) && typeof created.sessionId === "string");
        const model = modelOption(optionsOf(created));
        const chosen = harness === "grok" ? model?.values.find((item) => item.value.startsWith("xai/") && item.value.includes("grok-build"))
          : model?.values.find((item) => item.value.startsWith("swe-1-6-fast")) ?? model?.values.find((item) => item.value.startsWith("swe-"));
        assert.ok(chosen, `no suitable ${harness} text model was advertised`);
        const selected = await child.request("session/set_config_option", { sessionId: created.sessionId, configId: model!.id, value: chosen.value });
        const effort = effortOption(optionsOf(selected));
        const lowest = effort?.values.find((item) => ["low", "none", "minimal"].includes(item.value));
        if (lowest) await child.request("session/set_config_option", { sessionId: created.sessionId, configId: effort!.id, value: lowest.value });
        const marker = `AGENTSTACK_${harness.toUpperCase()}_ACP_READY`;
        const result = await child.request("session/prompt", { sessionId: created.sessionId,
          prompt: [{ type: "text", text: `Reply with exactly ${marker}. Do not call tools or change files.` }] }, 90_000);
        assert.equal(record(result) ? result.stopReason : null, "end_turn");
        assert.match(streamed.join(""), new RegExp(marker));
        console.log(JSON.stringify({ harness, selectedModel: chosen.value, selectedEffort: lowest?.value ?? null, stopReason: "end_turn", textReceived: true }));
      } finally { await child.close(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
