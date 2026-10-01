import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { codexRuntimePath } from "../src/paths.js";
import { Supervisor, appServerArgs, waitForReady } from "../src/supervisor.js";
import { appServerSocket } from "../src/threads.js";
import { chatRpc } from "../src/chats.js";

test("installed codexnk consumes and refreshes Role bot.md without replaying the orientation", { skip: !process.env.STACK_TEST_REAL_CODEX, timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-orientation-native-"));
  const requests: Record<string, unknown>[] = [];
  let nextRequest: (() => void) | undefined;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.endsWith("/responses")) { response.writeHead(404).end(); return; }
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    nextRequest?.();
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "orientation-response" } },
      { type: "response.output_item.done", item: { id: "introduction", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi, I'm your research collaborator. I can help investigate a question or review your next idea." }] } },
      { type: "response.completed", response: { id: "orientation-response", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  const supervisor = new Supervisor({ stateDir: root });
  try {
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
    const claims = Buffer.from(JSON.stringify({ email: "fixture@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "orientation-fixture" } })).toString("base64url");
    const account = supervisor.store.addAccount(JSON.stringify({ tokens: { refresh_token: "fixture-only", access_token: "fixture-only", id_token: `e30.${claims}.fixture` } })).id;
    const role = supervisor.role.role(supervisor.role.catalog().defaultRoleId!);
    role.update(0, { botMarkdown: "Be a measured research collaborator; your personality marker is native-orientation-fixture." });
    await supervisor.load();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    supervisor.onChange = () => { if (supervisor.list()[0]?.orientation?.state === "completed") finish(); };
    const bot = await supervisor.start({ id: "one", cwd: root, account, args: [
      "-c", 'model_provider="fixture"', "-c", 'model_providers.fixture.name="Fixture"',
      "-c", `model_providers.fixture.base_url=${JSON.stringify(baseUrl)}`, "-c", 'model_providers.fixture.wire_api="responses"',
      "-c", "model_providers.fixture.requires_openai_auth=false", "-c", "model_providers.fixture.request_max_retries=0",
      "-c", "model_providers.fixture.stream_max_retries=0", "-c", "model_providers.fixture.supports_websockets=false",
    ] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([completed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`native orientation unfinished: ${JSON.stringify(supervisor.list()[0]?.orientation)}`)), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    assert.equal(requests.length, 1);
    const sent = JSON.stringify(requests[0]);
    assert.match(sent, /native-orientation-fixture/);
    assert.match(sent, /initialization request from Stack/);
    const history = await chatRpc(bot.url!, "thread/turns/list", { threadId: bot.mainThreadId, itemsView: "full" });
    assert.match(JSON.stringify(history), /research collaborator/);
    assert.equal((history.data as unknown[]).length, 1);
    role.update(role.snapshot().revision, { botMarkdown: "Your current personality marker is native-next-launch-personality." });
    await supervisor.stop("one");
    const restarted = await supervisor.start({ id: "one", cwd: root });
    assert.equal(restarted.mainThreadId, bot.mainThreadId);
    assert.equal(restarted.orientation?.state, "completed");
    assert.equal(requests.length, 1, "resuming the exact root does not trigger a new model request");
    const follow = async (url: string, text: string) => {
      const observed = new Promise<void>((resolve) => { nextRequest = resolve; });
      await chatRpc(url, "turn/start", { threadId: bot.mainThreadId, input: [{ type: "text", text, text_elements: [] }] });
      try { await Promise.race([observed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("native follow-up never reached the fixture model")), 5_000); })]); }
      finally { if (timer) clearTimeout(timer); nextRequest = undefined; }
      return JSON.stringify(requests.at(-1));
    };
    const followUp = await follow(restarted.url!, "A human follow-up after relaunch");
    assert.match(followUp, /native-next-launch-personality/, "the resumed native root receives the newly captured Role personality");
    assert.match(followUp, /A human follow-up after relaunch/);
    role.update(role.snapshot().revision, { botMarkdown: "" });
    await supervisor.stop("one");
    const cleared = await supervisor.start({ id: "one", cwd: root });
    assert.equal(requests.length, 2, "clearing a personality also admits no model turn");
    await follow(cleared.url!, "A human follow-up after clearing");
    const input = requests.at(-1)!.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    const snapshots = input.filter((item) => item.role === "developer").flatMap((item) => item.content ?? []).map((part) => part.text ?? "").filter((text) => text.startsWith("[Stack Role launch instructions]"));
    assert.match(snapshots.at(-1)!, /current Role supplies no instruction Fragments or bot.md personality/);
    assert.doesNotMatch(snapshots.at(-1)!, /native-next-launch-personality/);
  } finally {
    await supervisor.stopAll(); await supervisor.runtime.close(); supervisor.role.close(); supervisor.store.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

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
