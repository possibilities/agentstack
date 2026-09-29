import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { codexRuntimePath } from "../src/paths.js";
import { appServerArgs, waitForReady } from "../src/supervisor.js";
import { appServerSocket } from "../src/threads.js";

test("installed codexnk retains its private runtime and honors Bot launch defaults", { skip: !process.env.STACK_TEST_REAL_CODEX }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-settings-native-"));
  const identity = join(root, "identity");
  const capabilities = join(root, "capabilities");
  const history = join(root, "history");
  const runtime = join(root, "runtime");
  await Promise.all([identity, capabilities, history, runtime].map((path) => mkdir(path, { mode: 0o700 })));
  const fakeAuth = JSON.stringify({ tokens: { refresh_token: "fixture-only" } });
  await writeFile(join(identity, "auth.json"), fakeAuth, { mode: 0o600 });
  const url = `unix://${join(root, "app.sock")}`;
  const env = { ...process.env, TMPDIR: runtime, STACK_STATE_DIR: root };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_HOME"]) delete (env as NodeJS.ProcessEnv)[key];
  const child = spawn(codexRuntimePath(), [...appServerArgs([], url, undefined, { model: "gpt-6-sol", model_reasoning_effort: "medium", sandbox_mode: "danger-full-access", approval_policy: "never",
    model_context_window: 120_000, model_auto_compact_token_limit_scope: "body_after_prefix", "agents.default_subagent_reasoning_effort": "high",
    "features.hooks": false, "features.multi_agent_v2.enabled": true, "features.multi_agent_v2.max_concurrent_threads_per_session": 3 }), "--identity", identity, "--capabilities", capabilities, "--history-dir", history], {
    env, cwd: root, stdio: "ignore",
  });
  let ws: ReturnType<typeof appServerSocket> | undefined;
  try {
    await waitForReady(url, new Promise((resolve) => child.once("exit", resolve)), 10_000);
    let home: string | null = null;
    for (let i = 0; i < 100 && !home; i += 1) {
      const children = await readdir(runtime);
      for (const name of children) {
        if ((await stat(join(runtime, name, "config.toml")).catch(() => null))?.isFile()) home = join(runtime, name);
      }
      if (!home) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(home, "codexnk should create its retained runtime inside TMPDIR");
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), fakeAuth);
    ws = appServerSocket(url);
    await new Promise<void>((resolve, reject) => { ws!.once("open", () => resolve()); ws!.once("error", reject); });
    const request = (id: number, method: string, params: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${method} timed out`)), 10_000);
      const onMessage = (raw: unknown) => {
        const frame = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (frame.id === id) finish(frame.error ? new Error(frame.error.message ?? method) : null, frame.result);
      };
      const finish = (error: Error | null, result?: Record<string, unknown>) => {
        clearTimeout(timer); ws!.off("message", onMessage);
        if (error) reject(error); else resolve(result ?? {});
      };
      ws!.on("message", onMessage);
      ws!.send(JSON.stringify({ id, method, params }));
    });
    await request(1, "initialize", { clientInfo: { name: "stack-test", version: "0.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    ws.send(JSON.stringify({ method: "initialized" }));
    const result = await request(2, "config/read", { includeLayers: false, cwd: root });
    const config = result.config as { model?: string; model_reasoning_effort?: string; approval_policy?: string; sandbox_mode?: string };
    assert.equal(config.model, "gpt-6-sol");
    assert.equal(config.model_reasoning_effort, "medium");
    assert.equal(config.approval_policy, "never");
    assert.equal(config.sandbox_mode, "danger-full-access");
    const resolved = result.config as Record<string, unknown>;
    assert.equal(resolved.model_context_window, 120_000);
    assert.equal(resolved.model_auto_compact_token_limit_scope, "body_after_prefix");
    assert.equal((resolved.agents as Record<string, unknown>).default_subagent_reasoning_effort, "high");
    const features = resolved.features as Record<string, unknown>;
    assert.equal(features.hooks, false);
    assert.equal((features.multi_agent_v2 as Record<string, unknown>).max_concurrent_threads_per_session, 3);
  } finally {
    ws?.close();
    child.kill("SIGTERM");
    let force: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => { force = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000); }),
      ]);
    } finally { if (force) clearTimeout(force); }
    await rm(root, { recursive: true, force: true });
  }
});
