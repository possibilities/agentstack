import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe } from "@agentstack/api";
import { AuthStore } from "@agentstack/auth";
import { StateStore } from "../src/store.js";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));
const credential = (token: string) => JSON.stringify({ tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });

test("codex lifecycle and change events are served on the namespaced unix socket", { timeout: 60_000 }, async () => {
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
  const authStore = new AuthStore(stateDir);
  authStore.addAccount(credential("first-secret"));
  const secondAccount = authStore.addAccount(credential("second-secret"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const served = await serveApi({ name: "codex", transport: "socket", env });
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "codex.sock"));
    assert.equal(auth.socketPath, join(stateDir, "sockets", "auth.sock"));
    const listedTools = (await socketCall(served.socketPath, "tools/list")) as {
      server: { name: string; description: string };
      transport: { type: string; path: string };
      websocket: unknown;
      events: { topics: Record<string, string>; subscribe: string } | null;
      tools: Array<{ name: string; description: string }>;
    };
    assert.equal(listedTools.server.name, "codex");
    assert.match(listedTools.server.description, /Start, stop, and list/);
    assert.equal(listedTools.transport.type, "socket");
    assert.equal(listedTools.transport.path, served.socketPath);
    assert.equal(listedTools.websocket, null);
    assert.deepEqual(listedTools.events?.subscribe, "events/subscribe");
    assert.deepEqual(listedTools.events?.topics, {
      servers_changed: "Published when a Codex app-server record starts, stops, exits, or is reaped.",
      threads_changed: "Published when a loaded Codex thread starts, changes status, or closes.",
      inputs_changed: "Published when an observed middleware candidate or its outcome changes; prompt bodies are never sent on this channel.",
    });
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name),
      ["server_start", "server_stop", "server_remove", "server_list", "input_observe_start", "input_observe_stop", "input_observe_list"],
    );
    assert.ok(listedTools.tools.every((tool) => tool.description.length > 0));

    const received: string[] = [];
    const events = await socketSubscribe(served.socketPath ?? "", ["servers_changed"], (topic) => received.push(topic));
    const scoped: string[] = [];
    const unrelated: string[] = [];
    const scopedEvents = await socketSubscribe(served.socketPath ?? "", ["servers_changed"], (topic) => scoped.push(topic), { scope: "remote" });
    const otherEvents = await socketSubscribe(served.socketPath ?? "", ["servers_changed"], (topic) => unrelated.push(topic), { scope: "other" });
    assert.deepEqual(events.topics, ["servers_changed"]);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["accounts_changed"] }), /unknown topic/);
    await assert.rejects(socketSubscribe(served.socketPath ?? "", ["servers_changed"], () => undefined, { scope: "invalid/id" }), /invalid event scope/);

    await assert.rejects(socketCall(served.socketPath, "tools/call", { name: "account_list", arguments: {} }), /unknown operation/);
    await socketCall(auth.socketPath ?? "", "tools/call", { name: "account_activate", arguments: { id: secondAccount.id } });

    const started = (await socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "remote" },
    })) as { id: string; state: string; url: string; account: string | null; mainThreadId: string | null };
    assert.equal(started.id, "remote");
    assert.equal(started.state, "running");
    assert.equal(started.account, secondAccount.id);
    assert.ok(started.mainThreadId);
    assert.equal(started.url, `unix://${join(stateDir, "app", "remote.sock")}`);
    const persisted = new StateStore(stateDir);
    assert.equal(persisted.servers().find((server) => server.id === "remote")?.codexBin, runtime);
    assert.equal(persisted.servers().find((server) => server.id === "remote")?.account, secondAccount.id);
    assert.equal(persisted.servers().find((server) => server.id === "remote")?.mainThreadId, started.mainThreadId);
    persisted.close();
    for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, ["servers_changed"]);
    assert.deepEqual(scoped, ["servers_changed"]);
    assert.deepEqual(unrelated, []);

    await assert.rejects(
      serveApi({ name: "codex", transport: "socket", env }),
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
    for (let i = 0; i < 100 && received.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, ["servers_changed", "servers_changed"]);
    assert.deepEqual(scoped, ["servers_changed", "servers_changed"]);
    assert.deepEqual(unrelated, []);

    await events.close();
    await scopedEvents.close();
    await otherEvents.close();
    received.length = 0;
    await socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "remote" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(received, []);

    await assert.rejects(
      socketCall(served.socketPath, "tools/call", { name: "server_start", arguments: {} }),
      /cwd/,
    );
    assert.deepEqual(await socketCall(served.socketPath, "tools/call", { name: "server_remove", arguments: { id: "remote" } }), { id: "remote" });
    const removed = (await socketCall(served.socketPath, "tools/call", { name: "server_list", arguments: {} })) as { servers: Array<{ id: string }> };
    assert.equal(removed.servers.some((server) => server.id === "remote"), false);
    const checked = new StateStore(stateDir);
    assert.equal(checked.hasServer("remote"), false);
    checked.close();
    await assert.rejects(lstat(join(stateDir, "history", "remote")), /ENOENT/);
  } finally {
    await served.close();
    await auth.close();
    authStore.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
