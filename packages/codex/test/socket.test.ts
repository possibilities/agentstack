import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { serveApi, socketCall } from "@agentstack/api";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));

test("codex lifecycle is served on the namespaced unix socket", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-codex-api-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-codex-cwd-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  process.env.HOME = cwd;
  const runtime = join(cwd, ".local", "libexec", "codexnk", "codex");
  await mkdir(join(runtime, ".."), { recursive: true });
  await symlink(fakeBin, runtime);
  // A working PATH alternative must never substitute for the required runtime.
  await symlink(fakeBin, join(cwd, "codex"));
  process.env.PATH = `${cwd}:${savedPath ?? ""}`;
  const served = await serveApi({
    name: "codex",
    transport: "socket",
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir },
  });
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "codex.sock"));
    const listedTools = (await socketCall(served.socketPath, "tools/list")) as {
      server: { name: string; description: string };
      transport: { type: string; path: string };
      websocket: { url: string; topics: Record<string, string> } | null;
      tools: Array<{ name: string; description: string }>;
    };
    assert.equal(listedTools.server.name, "codex");
    assert.match(listedTools.server.description, /Start, stop, and list/);
    assert.equal(listedTools.transport.type, "socket");
    assert.equal(listedTools.transport.path, served.socketPath);
    assert.equal(listedTools.websocket?.url, served.websocketUrl);
    assert.match(listedTools.websocket?.url ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(listedTools.websocket?.topics, {
      servers_changed: "Published when a Codex app-server record starts, stops, exits, or is reaped.",
      threads_changed: "Published when a loaded Codex thread starts, changes status, or closes.",
      inputs_changed: "Published when an observed middleware candidate or its outcome changes; prompt bodies are never sent on this websocket.",
    });

    const events = subscribe(served.websocketUrl ?? "", "servers_changed");
    assert.deepEqual(await events.next(), { type: "subscribed", topic: "servers_changed" });
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name),
      ["server_start", "server_stop", "server_list", "input_observe_start", "input_observe_stop", "input_observe_list"],
    );
    assert.ok(listedTools.tools.every((tool) => tool.description.length > 0));

    const started = (await socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "remote" },
    })) as { id: string; state: string; url: string };
    assert.equal(started.id, "remote");
    assert.equal(started.state, "running");
    assert.equal(started.url, `unix://${join(stateDir, "app", "remote.sock")}`);
    assert.equal(JSON.parse(await readFile(join(stateDir, "servers", "remote.json"), "utf8")).codexBin, runtime);
    assert.deepEqual(await events.next(), { type: "event", topic: "servers_changed" });

    await assert.rejects(
      serveApi({ name: "codex", transport: "socket", env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir } }),
      /already listening/,
    );

    const listed = (await socketCall(served.socketPath, "tools/call", {
      name: "server_list",
      arguments: {},
    })) as { servers: Array<{ id: string }> };
    assert.equal(listed.servers.some((server) => server.id === "remote"), true);
    assert.equal((listed.servers.find((server) => server.id === "remote") as { state?: string }).state, "running");

    await assert.rejects(socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "override", codexBin: fakeBin },
    }), /codexBin|Unrecognized/);
    await rm(runtime);
    await assert.rejects(socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "missing-bin" },
    }), /required codexnk runtime is missing/);
    await symlink(fakeBin, runtime);
    const afterBadBin = (await socketCall(served.socketPath, "tools/call", {
      name: "server_list", arguments: {},
    })) as { servers: Array<{ id: string; state: string }> };
    assert.equal(afterBadBin.servers.find((server) => server.id === "remote")?.state, "running");

    const stopped = (await socketCall(served.socketPath, "tools/call", {
      name: "server_stop",
      arguments: { id: "remote" },
    })) as { state: string };
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(await events.next(), { type: "event", topic: "servers_changed" });

    events.unsubscribe("servers_changed");
    assert.deepEqual(await events.next(), { type: "unsubscribed", topic: "servers_changed" });
    await socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "remote" },
    });
    await assert.rejects(events.next(300), /no frame/);

    await assert.rejects(
      socketCall(served.socketPath, "tools/call", { name: "server_start", arguments: {} }),
      /cwd/,
    );
    events.close();
  } finally {
    await served.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

type Frame = { type?: string; topic?: string };

function subscribe(url: string, topic: string) {
  const ws = new WebSocket(url);
  const queue: Frame[] = [];
  let waiter: ((frame: Frame) => void) | null = null;
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as Frame;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(frame);
    } else {
      queue.push(frame);
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  void opened.then(() => ws.send(JSON.stringify({ type: "subscribe", topic })));
  return {
    async next(timeoutMs = 5_000): Promise<Frame> {
      await opened;
      if (queue.length > 0) return queue.shift() as Frame;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error("no frame received"));
        }, timeoutMs);
        waiter = (frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
      });
    },
    unsubscribe(topicName: string) {
      ws.send(JSON.stringify({ type: "unsubscribe", topic: topicName }));
    },
    close() {
      ws.close();
    },
  };
}
