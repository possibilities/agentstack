import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, type ServedApi } from "@agentstack/api";
import { StateStore } from "@agentstack/codex";

const fakeBin = fileURLToPath(new URL("../../../codex/test/fixtures/fake-app-server.mjs", import.meta.url));

type View = { id: string; pid: number | null; cwd: string; url: string | null; state: string; account: string | null; mainThreadId: string | null };

function call(socket: string, name: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
  return socketCall(socket, "tools/call", { name, arguments: args }, { timeoutMs });
}

test("bots lifecycle is served on the namespaced unix socket", { timeout: 120_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-bots-state-"));
  const home = await mkdtemp(join(tmpdir(), "agentstack-bots-home-"));
  const workDir = await mkdtemp(join(tmpdir(), "agentstack-bots-work-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const runtime = join(home, ".local", "libexec", "codexnk", "codex");
  await mkdir(join(runtime, ".."), { recursive: true });
  await symlink(fakeBin, runtime);
  const store = new StateStore(stateDir);
  store.addAccount(JSON.stringify({ tokens: { refresh_token: "test-refresh", access_token: "access", id_token: "fixture.jwt.signature" } }));
  store.close();
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  let codex = await serveApi({ name: "codex", transport: "socket", env });
  const codexSocket = codex.socketPath ?? "";
  const botsSocket = join(stateDir, "sockets", "bots.sock");
  let bots: ServedApi | undefined = await serveApi({ name: "bots", transport: "socket", env });
  try {
    assert.equal(bots.socketPath, botsSocket);
    const listedTools = (await socketCall(botsSocket, "tools/list")) as {
      server: { name: string; description: string };
      transport: { type: string; path: string };
      websocket: { url: string } | null;
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; additionalProperties?: boolean } }>;
    };
    assert.equal(listedTools.server.name, "bots");
    assert.equal(listedTools.transport.type, "socket");
    assert.equal(listedTools.transport.path, botsSocket);
    assert.equal(listedTools.websocket, null);
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name),
      ["bot_start", "bot_stop", "bot_list"],
    );
    const startSchema = listedTools.tools.find((tool) => tool.name === "bot_start")?.inputSchema;
    assert.deepEqual(Object.keys(startSchema?.properties ?? {}).sort(), ["args", "id"]);
    assert.equal(startSchema?.additionalProperties, false);

    await assert.rejects(call(botsSocket, "bot_start", { id: "bot-4" }), /unknown bot: bot-4/);
    await assert.rejects(call(botsSocket, "bot_start", { id: "bot-99999999999999999999" }), /unknown bot/);
    await assert.rejects(call(botsSocket, "bot_start", { id: "server-1" }), /id/);
    await assert.rejects(call(botsSocket, "bot_start", { cwd: workDir }), /cwd|Unrecognized/);
    await assert.rejects(call(botsSocket, "bot_stop", { id: "bot-4" }), /unknown bot: bot-4/);

    const first = (await call(botsSocket, "bot_start")) as View;
    assert.equal(first.id, "bot-1");
    assert.equal(first.state, "running");
    assert.equal(first.cwd, join(stateDir, "bots", "bot-1"));
    assert.equal(first.url, `unix://${join(stateDir, "app", "bot-1.sock")}`);
    assert.equal(first.account, "codex-1");
    assert.ok(first.mainThreadId);
    const firstWorkspace = await lstat(first.cwd);
    assert.equal(firstWorkspace.isDirectory(), true);
    assert.equal(firstWorkspace.mode & 0o777, 0o700);
    const ledgerMode = await lstat(join(stateDir, "bots", "ledger.sqlite"));
    assert.equal(ledgerMode.mode & 0o777, 0o600);

    const again = (await call(botsSocket, "bot_start", { id: "bot-1" })) as View;
    assert.equal(again.id, "bot-1");
    assert.equal(again.state, "running");
    assert.equal(again.pid, first.pid);
    assert.equal(again.mainThreadId, first.mainThreadId);

    const second = (await call(botsSocket, "bot_start")) as View;
    assert.equal(second.id, "bot-2");
    assert.equal(second.cwd, join(stateDir, "bots", "bot-2"));

    const unrelated = (await call(codexSocket, "server_start", { id: "other", cwd: workDir })) as View;
    assert.equal(unrelated.id, "other");

    const listed = (await call(botsSocket, "bot_list")) as { bots: View[] };
    assert.deepEqual(listed.bots.map((bot) => bot.id), ["bot-1", "bot-2"]);
    assert.ok(listed.bots.every((bot) => bot.cwd === join(stateDir, "bots", bot.id)));
    const codexListed = (await call(codexSocket, "server_list")) as { servers: View[] };
    assert.ok(codexListed.servers.some((server) => server.id === "other"));

    const stopped = (await call(botsSocket, "bot_stop", { id: "bot-1" })) as View;
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.cwd, first.cwd);
    const restarted = (await call(botsSocket, "bot_start", { id: "bot-1" })) as View;
    assert.equal(restarted.state, "running");
    assert.equal(restarted.mainThreadId, first.mainThreadId);

    const concurrent = (await Promise.all([
      call(botsSocket, "bot_start"),
      call(botsSocket, "bot_start"),
      call(botsSocket, "bot_start"),
    ])) as View[];
    assert.deepEqual(concurrent.map((view) => view.id).sort(), ["bot-3", "bot-4", "bot-5"]);

    await rm(runtime);
    await assert.rejects(call(botsSocket, "bot_start"), /required codexnk runtime is missing/);
    const neverStarted = (await call(botsSocket, "bot_stop", { id: "bot-6" })) as View;
    assert.equal(neverStarted.state, "stopped");
    assert.equal(neverStarted.cwd, join(stateDir, "bots", "bot-6"));
    await symlink(fakeBin, runtime);
    const afterFailure = (await call(botsSocket, "bot_start")) as View;
    assert.equal(afterFailure.id, "bot-7");

    await mkdir(join(stateDir, "bots", "bot-8"));
    await symlink(workDir, join(stateDir, "bots", "bot-9"));
    const afterCollision = (await call(botsSocket, "bot_start")) as View;
    assert.equal(afterCollision.id, "bot-10");

    const foreign = (await call(codexSocket, "server_start", { id: "bot-11", cwd: workDir })) as View;
    assert.equal(foreign.cwd, workDir);
    const afterForeign = (await call(botsSocket, "bot_start")) as View;
    assert.equal(afterForeign.id, "bot-12");
    await assert.rejects(call(botsSocket, "bot_start", { id: "bot-11" }), /unknown bot: bot-11/);
    const filtered = (await call(botsSocket, "bot_list")) as { bots: View[] };
    assert.ok(!filtered.bots.some((bot) => bot.id === "bot-11" || bot.id === "other"));
    assert.ok(filtered.bots.some((bot) => bot.id === "bot-1" && bot.state === "running"));

    await rm(join(stateDir, "bots", "bot-2"), { recursive: true, force: true });
    await symlink(workDir, join(stateDir, "bots", "bot-2"));
    await assert.rejects(call(botsSocket, "bot_start", { id: "bot-2" }), /not a directory/);
    await rm(join(stateDir, "bots", "bot-2"));
    await mkdir(join(stateDir, "bots", "bot-2"));

    await bots.close();
    bots = await serveApi({ name: "bots", transport: "socket", env });
    const afterRestart = (await call(botsSocket, "bot_start")) as View;
    assert.equal(afterRestart.id, "bot-13");
    const stillRunning = (await call(codexSocket, "server_list")) as { servers: View[] };
    assert.equal(stillRunning.servers.find((server) => server.id === "bot-1")?.state, "running");
    assert.equal(stillRunning.servers.find((server) => server.id === "other")?.state, "running");

    await bots.close();
    bots = undefined;
    await codex.close();
    codex = await serveApi({ name: "codex", transport: "socket", env });
    bots = await serveApi({ name: "bots", transport: "socket", env });
    const booted = (await call(botsSocket, "bot_list")) as { bots: View[] };
    assert.equal(booted.bots.length, 9); // bot-6 was reserved, but never successfully started.
    assert.ok(booted.bots.every((bot) => bot.state === "running" && bot.mainThreadId));
    assert.equal(booted.bots.find((bot) => bot.id === "bot-1")?.mainThreadId, first.mainThreadId);
    const afterBoot = (await call(codexSocket, "server_list")) as { servers: View[] };
    assert.equal(afterBoot.servers.find((server) => server.id === "other")?.state, "running");
    assert.equal(afterBoot.servers.find((server) => server.id === "other")?.mainThreadId, unrelated.mainThreadId);
    assert.equal(afterBoot.servers.find((server) => server.id === "bot-11")?.state, "running");
    const history = (await readFile(join(stateDir, "history", "fake-threads.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { method: string; threadId: string; cwd: string });
    assert.equal(history.filter((entry) => entry.method === "thread/start" && entry.cwd === first.cwd).length, 1);
    assert.ok(history.filter((entry) => entry.method === "thread/resume" && entry.cwd === first.cwd).length >= 2);
  } finally {
    await bots?.close();
    await codex.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(stateDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("bots refuses a workspace root that is not a real directory", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-bots-rootstate-"));
  const target = await mkdtemp(join(tmpdir(), "agentstack-bots-roottarget-"));
  const root = join(stateDir, "bots");
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  try {
    await symlink(target, root);
    await assert.rejects(serveApi({ name: "bots", transport: "socket", env }), /not a directory/);
    await rm(root);
    await writeFile(root, "not a directory");
    await assert.rejects(serveApi({ name: "bots", transport: "socket", env }), /not a directory/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
