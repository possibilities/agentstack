import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { Supervisor, type LaunchSpec } from "../src/supervisor.js";
import { codexRuntimePath } from "../src/paths.js";

/** Native protocol peer: owns roots and turn evidence independently of Stack's persisted initialization. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stack-orientation-"));
  const http = createServer(), wss = new WebSocketServer({ server: http });
  const roots = new Map<string, Array<{ id: string; status: string; items: unknown[] }>>();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const launches: LaunchSpec[] = [];
  let lose: "root" | "turn" | null = null, unreadable = false, resumeBlocked = false;
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (!frame.id) return;
    const { method, params = {} } = frame;
    requests.push({ method, params });
    const reply = (result: unknown) => peer.send(JSON.stringify({ id: frame.id, result }));
    const refuse = () => peer.send(JSON.stringify({ id: frame.id, error: { message: "native history unavailable" } }));
    switch (method) {
      case "initialize": reply({}); break;
      case "thread/inject_items": reply({}); break;
      case "thread/start": {
        const id = randomUUID(); roots.set(id, []);
        if (lose === "root") { lose = null; peer.terminate(); } else reply({ thread: { id } });
        break;
      }
      case "thread/resume":
        if (resumeBlocked || !roots.get(params.threadId)?.length) refuse(); else reply({ thread: { id: params.threadId } });
        break;
      case "turn/start": {
        const turn = { id: randomUUID(), status: "inProgress", items: [{ type: "userMessage", content: params.input }] };
        roots.get(params.threadId)!.push(turn);
        if (lose === "turn") { lose = null; unreadable = true; peer.terminate(); } else reply({ turn });
        break;
      }
      case "thread/turns/list":
        if (unreadable) refuse(); else reply({ data: roots.get(params.threadId) ?? [], nextCursor: null });
        break;
      case "thread/list": reply({ data: [...roots.keys()].map((id) => ({ id, ephemeral: false, parentThreadId: null })), nextCursor: null }); break;
      case "thread/read": reply({ thread: { id: params.threadId, status: { type: "idle" }, turns: roots.get(params.threadId) ?? [] } }); break;
      default: refuse();
    }
  }));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(http.address() as { port: number }).port}`;
  const supervisors: Supervisor[] = [];
  const make = () => {
    const supervisor = new Supervisor({ stateDir: root, endpoint: async () => url, waitReady: async () => undefined,
      launch(spec) {
        launches.push(spec);
        let finish!: (code: number | null) => void;
        return { pid: 100 + launches.length, exited: new Promise((resolve) => { finish = resolve; }), kill: () => finish(0) };
      },
    });
    supervisors.push(supervisor); return supervisor;
  };
  const supervisor = make();
  const account = supervisor.store.addAccount(JSON.stringify({ tokens: { refresh_token: "fixture", access_token: "fixture", id_token: "fixture.jwt.signature" } })).id;
  await supervisor.load();
  const change = (threadId: string, turnId: string, status: string) => {
    const turn = roots.get(threadId)?.find((turn) => turn.id === turnId);
    if (turn) turn.status = status;
    for (const peer of wss.clients) peer.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } }));
  };
  const waitState = (supervisor: Supervisor, state: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { supervisor.onChange = undefined; reject(new Error(`orientation did not reach ${state}`)); }, 3_000);
    const inspect = () => { if (supervisor.list()[0]?.orientation?.state === state) { clearTimeout(timer); supervisor.onChange = undefined; resolve(); } };
    supervisor.onChange = inspect; inspect();
  });
  return { root, supervisor, account, make, roots, requests, launches, change, waitState,
    loseReply(stage: "root" | "turn") { lose = stage; }, allowReads() { unreadable = false; },
    blockResume(blocked: boolean) { resumeBlocked = blocked; },
    async close() {
      for (const owner of supervisors) { await owner.stopAll(); await owner.runtime.close(); owner.role.close(); owner.store.close(); }
      for (const peer of wss.clients) peer.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("new Bot orientation returns on admission, follows only its exact turn, and does not repeat after Role edits or restart", async () => {
  const f = await fixture();
  try {
    const role = f.supervisor.role.role(f.supervisor.role.catalog().defaultRoleId!);
    role.update(role.snapshot().revision, { botMarkdown: "Be a calm researcher." });
    const bot = await f.supervisor.start({ id: "one", cwd: f.root, account: f.account });
    assert.equal(bot.orientation?.state, "running", "thread idle and an admission ACK are not orientation completion");
    assert.equal(bot.mainThreadId, bot.orientation?.threadId);
    assert.ok(bot.orientation?.turnId);
    const launchRoot = f.launches[0]!.args[f.launches[0]!.args.indexOf("--capabilities") + 1]!;
    assert.equal(await readFile(join(launchRoot, "bot.md"), "utf8"), "Be a calm researcher.");
    const admission = f.requests.find((request) => request.method === "turn/start")!.params;
    assert.equal(admission.clientUserMessageId, bot.orientation!.admissionId);
    assert.equal(admission.turnTrigger, "stack_orientation");
    assert.match((admission.input as Array<{ text: string }>)[0]!.text, /initialization request from Stack, not a message or authorization from the human/);
    role.update(role.snapshot().revision, { botMarkdown: "Be a lively collaborator." });
    assert.equal(await readFile(join(launchRoot, "bot.md"), "utf8"), "Be a calm researcher.");
    f.change(bot.mainThreadId!, "unrelated-turn", "completed");
    f.change("unrelated-root", bot.orientation!.turnId!, "completed");
    // Observe reconciliation through a stop/start rather than assuming a quiet interval proves anything.
    await f.supervisor.stop("one");
    const resumed = await f.supervisor.start({ id: "one", cwd: f.root });
    assert.equal(resumed.orientation?.state, "running");
    const completed = f.waitState(f.supervisor, "completed");
    f.change(bot.mainThreadId!, bot.orientation!.turnId!, "completed");
    await completed;
    assert.equal(f.supervisor.store.servers()[0]!.orientation?.state, "completed");
    await f.supervisor.stop("one");
    const recovered = f.make(); await recovered.load();
    const restarted = await recovered.start({ id: "one", cwd: f.root });
    assert.equal(restarted.mainThreadId, bot.mainThreadId);
    assert.equal(restarted.orientation?.state, "completed");
    assert.equal(f.requests.filter((request) => request.method === "thread/start").length, 1);
    assert.equal(f.requests.filter((request) => request.method === "turn/start").length, 1);
    assert.equal(f.requests.filter((request) => request.method === "thread/inject_items").length, 1, "changed instructions are delivered once, and their acknowledged hash survives owner restart");
    const latest = f.launches.at(-1)!;
    assert.equal(await readFile(join(latest.args[latest.args.indexOf("--capabilities") + 1]!, "bot.md"), "utf8"), "Be a lively collaborator.");
  } finally { await f.close(); }
});

test("lost orientation turn acknowledgement reconciles exact history after owner restart without resending", async () => {
  const f = await fixture();
  try {
    f.loseReply("turn");
    const bot = await f.supervisor.start({ id: "one", cwd: f.root, account: f.account });
    assert.equal(bot.orientation?.state, "unknown");
    assert.equal(bot.orientation?.turnId, null);
    await f.supervisor.stop("one");
    const recovered = f.make(); await recovered.load(); f.allowReads();
    const restarted = await recovered.start({ id: "one", cwd: f.root });
    assert.equal(restarted.orientation?.state, "running");
    assert.equal(restarted.mainThreadId, bot.mainThreadId);
    assert.equal(restarted.orientation?.turnId, f.roots.get(bot.mainThreadId!)![0]!.id);
    assert.equal(f.requests.filter((request) => request.method === "turn/start").length, 1);
    const finished = f.waitState(recovered, "interrupted");
    f.change(bot.mainThreadId!, restarted.orientation!.turnId!, "interrupted"); await finished;
    await recovered.stop("one");
    // Reconstruct the unresolved durable admission, as after an owner crashed before recording completion.
    const stored = recovered.store.servers()[0]!;
    recovered.store.saveServer({ ...stored, orientation: { ...stored.orientation!, state: "unknown", issue: "Outcome not yet observed" } });
    const unavailable = f.make(); await unavailable.load(); f.blockResume(true);
    const fenced = await unavailable.start({ id: "one", cwd: f.root });
    assert.equal(fenced.orientation?.state, "unknown", "terminal native history cannot settle initialization while its root fails to resume");
    await unavailable.stop("one"); f.blockResume(false);
    assert.equal((await unavailable.start({ id: "one", cwd: f.root })).orientation?.state, "interrupted");
    assert.equal(f.requests.filter((request) => request.method === "turn/start").length, 1);
  } finally { await f.close(); }
});

test("lost root allocation acknowledgement stays fenced across restart and exact conversation reset retires orientation", async () => {
  const f = await fixture();
  try {
    f.loseReply("root");
    const bot = await f.supervisor.start({ id: "one", cwd: f.root, account: f.account });
    assert.equal(bot.orientation?.state, "unknown");
    assert.equal(bot.mainThreadId, null);
    assert.equal(await f.supervisor.adoptMainThread("one", bot.url!), null);
    await assert.rejects(f.supervisor.openMainChat("one", [{ type: "text", text: "another root" }]), /orientation is unfinished/);
    await f.supervisor.stop("one");
    const recovered = f.make(); await recovered.load();
    assert.equal((await recovered.start({ id: "one", cwd: f.root })).orientation?.state, "unknown");
    assert.equal(f.roots.size, 1);
    assert.equal(f.requests.filter((request) => request.method === "turn/start").length, 0);
    await recovered.stop("one");
    const identity = recovered.store.stateIdentity("one");
    await recovered.maintain("one", async () => recovered.resetConversation("one", identity.generation));
    assert.equal(recovered.list()[0]!.orientation?.state, "retired");
    assert.equal((await recovered.start({ id: "one", cwd: f.root })).orientation?.state, "retired");
    assert.equal(f.roots.size, 1, "explicit reset does not automatically repeat introduction");
  } finally { await f.close(); }
});

test("existing empty Bots keep first-UI-turn behavior and are not enrolled in automatic orientation", async () => {
  const f = await fixture();
  try {
    f.supervisor.store.saveServer({ id: "legacy", cwd: f.root, pid: null, url: null, state: "stopped", codexBin: codexRuntimePath(),
      account: f.account, launchedAccount: null, authVersion: null, runtimeRoot: null, mainThreadId: null, threadStarting: false, args: [] });
    await f.supervisor.load();
    const bot = await f.supervisor.start({ id: "legacy", cwd: f.root });
    assert.equal(bot.orientation, null);
    assert.equal(bot.mainThreadId, null);
    assert.equal(f.roots.size, 0);
    const opened = await f.supervisor.openMainChat("legacy", [{ type: "text", text: "Human first turn" }]);
    assert.equal(f.supervisor.list()[0]?.mainThreadId, opened.threadId);
    assert.equal(f.supervisor.list()[0]?.orientation, null);
  } finally { await f.close(); }
});
