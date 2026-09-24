import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { codexRuntimePath } from "../src/paths.js";
import { appServerArgs, waitForReady } from "../src/supervisor.js";
import { appServerSocket } from "../src/threads.js";

test("installed codexnk retains its private runtime and honors full-access Bot defaults", { skip: !process.env.AGENTSTACK_TEST_REAL_CODEX }, async () => {
  const root = await mkdtemp("/tmp/as-full-");
  const identity = join(root, "identity");
  const capabilities = join(root, "capabilities");
  const history = join(root, "history");
  const runtime = join(root, "runtime");
  await Promise.all([identity, capabilities, history, runtime].map((path) => mkdir(path, { mode: 0o700 })));
  const fakeAuth = JSON.stringify({ tokens: { refresh_token: "fixture-only" } });
  await writeFile(join(identity, "auth.json"), fakeAuth, { mode: 0o600 });
  const url = `unix://${join(root, "app.sock")}`;
  const child = spawn(codexRuntimePath(), [...appServerArgs([], url), "--identity", identity, "--capabilities", capabilities, "--history-dir", history], {
    env: { ...process.env, TMPDIR: runtime }, stdio: "ignore",
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
    await request(1, "initialize", { clientInfo: { name: "agentstack-test", version: "0.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    ws.send(JSON.stringify({ method: "initialized" }));
    const result = await request(2, "config/read", { includeLayers: false, cwd: root });
    const config = result.config as { approval_policy?: string; sandbox_mode?: string };
    assert.equal(config.approval_policy, "never");
    assert.equal(config.sandbox_mode, "danger-full-access");
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
