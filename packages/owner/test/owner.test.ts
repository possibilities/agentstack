import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { serveApi } from "@agentstack/api";
import { codexChild } from "../src/codex.js";
import { startOwner } from "../src/owner.js";
import { ownerUiData, setOwnerUiSource } from "../src/ui-source.js";

const childBin = fileURLToPath(new URL("../../test/fixtures/child.mjs", import.meta.url));

test("the owner stops a child it started", async () => {
  const owner = startOwner([{ name: "fixture", command: process.execPath, args: [childBin] }]);
  await owner.close();
});

test("the codex child serves the codex socket", () => {
  const child = codexChild();
  assert.equal(child.name, "codex");
  assert.equal(child.command, process.execPath);
  assert.deepEqual(child.args.slice(1), ["codex", "socket"]);
  assert.equal(existsSync(child.args[0] ?? ""), true);
});

test("owner onChange fires on pid set transitions only", async () => {
  const events: number[] = [];
  const owner = startOwner(
    [
      { name: "fixture", command: process.execPath, args: [childBin] },
      { name: "missing", command: "agentstack-missing-binary", args: [] },
      { name: "exit", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ],
    process.env,
    () => events.push(events.length + 1),
  );
  try {
    await waitFor(() => events.length >= 2 && owner.children().length === 1, 5_000);
    assert.equal(owner.children()[0]?.name, "fixture");
  } finally {
    await owner.close();
  }
  await waitFor(() => events.length >= 3, 5_000);
  assert.equal(owner.children().length, 0);
});

test("owner close resolves promptly after a failed spawn", async () => {
  const owner = startOwner([{ name: "missing", command: "agentstack-missing-binary", args: [] }]);
  await waitFor(() => owner.children().length === 0, 5_000);
  await Promise.race([
    owner.close(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close hung")), 1_000)),
  ]);
});

test("owner api serves its websocket transport and publishes pids_changed", async () => {
  await assert.rejects(
    serveApi({ name: "codex", transport: "websocket", env: { ...process.env } }),
    /served alongside its socket/,
  );
  const served = await serveApi({ name: "owner", transport: "websocket", env: { ...process.env } });
  const ws = new WebSocket(served.websocketUrl ?? "");
  try {
    assert.equal(served.socketPath, undefined);
    assert.match(served.websocketUrl ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "subscribe", topic: "pids_changed" }));
    assert.deepEqual(await nextFrame(ws), { type: "subscribed", topic: "pids_changed" });
    served.publish?.("pids_changed");
    assert.deepEqual(await nextFrame(ws), { type: "event", topic: "pids_changed" });
  } finally {
    ws.close();
    await served.close();
    await served.close();
  }
});

test("owner ui source carries the websocket url", () => {
  setOwnerUiSource(() => ({ pid: 1, children: [], websocketUrl: "ws://127.0.0.1:9" }));
  assert.equal(ownerUiData().websocketUrl, "ws://127.0.0.1:9");
  setOwnerUiSource(() => ({ pid: 1, children: [] }));
  assert.equal(ownerUiData().websocketUrl, undefined);
});

type Frame = { type?: string; topic?: string };

function nextFrame(ws: WebSocket, timeoutMs = 5_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame received")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as Frame);
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), "condition was not met before the deadline");
}
