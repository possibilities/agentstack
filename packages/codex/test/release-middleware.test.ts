import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { attachInputMiddleware, type InputResolution } from "../src/middleware.js";

const runtime = process.env.CODEXNK_TEST_BIN;

test("verified release intercepts a second WebSocket client's typed input", { skip: !runtime, timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "codexnk-release-middleware-"));
  const socket = join(home, "codex.sock");
  const child = spawn(runtime!, ["app-server", "--listen", `unix://${socket}`], {
    cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  let submitter: WebSocket | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const trySocket = () => {
        if (Date.now() > deadline) return reject(new Error(`app-server did not open: ${output.join("")}`));
        const socketClient = connect(socket);
        socketClient.once("connect", () => { socketClient.destroy(); resolve(); });
        socketClient.once("error", () => { socketClient.destroy(); setTimeout(trySocket, 50); });
      };
      trySocket();
    });
    submitter = new WebSocket("ws://localhost/", { createConnection: () => connect(socket) });
    await new Promise<void>((resolve, reject) => {
      submitter!.once("open", resolve);
      submitter!.once("error", reject);
    });
    let id = 0;
    const request = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => { submitter!.off("message", onMessage); reject(new Error(`${method} timed out`)); }, 5_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message: string } };
        if (message.id !== current) return;
        clearTimeout(timer);
        submitter!.off("message", onMessage);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      submitter!.on("message", onMessage);
      submitter!.send(JSON.stringify({ id: current, method, params }));
    });
    await request("initialize", { clientInfo: { name: "agentstack-release-test", version: "0.0.0" } });
    submitter.send(JSON.stringify({ method: "initialized" }));
    const started = await request("thread/start", {}) as { thread: { id: string } };
    assert.ok(started.thread.id);
    let finish!: (resolution: InputResolution) => void;
    const resolved = new Promise<InputResolution>((resolve) => { finish = resolve; });
    const middleware = await attachInputMiddleware(`unix://${socket}`, started.thread.id,
      () => ({ type: "intercept", operationId: "release-op" }), finish, { onUnavailable: "reject" });
    try {
      await assert.rejects(request("turn/start", {
        threadId: started.thread.id, clientUserMessageId: "release-test-input",
        input: [{ type: "text", text: "do not run", text_elements: [] }],
      }), /input intercepted/);
      const resolution = await resolved;
      assert.deepEqual(resolution.disposition, { type: "intercepted", operationId: "release-op" });
      const record = await middleware.read(resolution.inputId);
      assert.equal(record?.originalText, "do not run");
      const completed = await middleware.complete(resolution.inputId, "release-op", { status: "succeeded", summary: "Recorded" });
      assert.equal(completed.effect?.status, "succeeded");
    } finally {
      await middleware.detach();
    }
  } finally {
    submitter?.terminate();
    child.kill("SIGTERM");
    if (child.exitCode === null) await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
