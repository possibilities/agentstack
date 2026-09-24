import { lstatSync, mkdirSync } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { operation, workspaceRoot, type PackageApi } from "@agentstack/api";
import { BotLedger } from "./src/ledger.js";
import { ownerMcpUrls } from "./src/owner-mcp.js";
import { stateDir } from "./src/paths.js";
import { StateStore } from "./src/store.js";
import { Supervisor, type ServerView } from "./src/supervisor.js";
import { watchThreadEvents } from "./src/threads.js";
import { VoiceCalls } from "./src/voice.js";

const botId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).describe("Bot id. Omit for the next bot-N; supply a name to override it.");
const botView = z.object({
  id: botId,
  pid: z.number().int().nullable().describe("Process id while running, otherwise null."),
  cwd: z.string().describe("Working directory. Defaults to the private bots/bot-N workspace."),
  url: z.string().nullable().describe("Codex app-server endpoint while running, otherwise null."),
  state: z.enum(["running", "stopped"]),
  account: z.uuid().nullable().describe("Assigned Codex account ID, or null while unbound."),
  runningAccount: z.uuid().nullable().describe("Account used by the running process, or null when stopped or launched unbound. Stop/start to apply a changed assignment."),
  mainThreadId: z.string().nullable().describe("First durable root thread, or null until a UI sends its first turn."),
  recoveryIssue: z.string().nullable().describe("Process-ownership issue requiring inspection; a running state is unverified while this is set."),
  roleRevision: z.number().int().nonnegative().nullable().describe("Last launched role revision, or null before launch. Compare with role_snapshot; restart to apply edits."),
});

export type BotsContext = { root: string; ledger: BotLedger; store: StateStore; supervisor: Supervisor; voice: VoiceCalls };
export const topics = {
  bots_changed: "Published when a bot starts, stops, exits, changes assignment, or is fenced for recovery. Refresh bot_list.",
  threads_changed: "Published when loaded thread state for this bot changes or its Codex connection resumes. Read its app-server thread state.",
  voice_changed: "Published when the single voice call starts, connects, or ends. Refresh voice_status; the notice carries no SDP or audio.",
} as const;
export type BotsTopic = keyof typeof topics;

function workspacePath(root: string, id: string): string { return join(root, id); }
function claimWorkspace(root: string, taken: Set<string>, create = true): (id: string) => boolean {
  return (id) => {
    if (taken.has(id)) return false;
    const path = workspacePath(root, id);
    try { lstatSync(path); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!create) return true;
    try { mkdirSync(path, { mode: 0o700 }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  };
}
async function ensureWorkspace(path: string): Promise<string> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (info === undefined) { await mkdir(path, { mode: 0o700 }); return path; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`bot workspace is not a directory: ${path}`);
  return path;
}

async function claimNamedWorkspace(path: string): Promise<string> {
  try { await mkdir(path, { mode: 0o700 }); return path; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`bot workspace already exists: ${path}; supply cwd to use an existing directory`);
    throw error;
  }
}

export const botStart = operation({
  name: "bot_start",
  description: "Start a bot without creating a thread, or return the live one. By default allocate the next bot-N in its private workspace and bind the active Codex account. Override id, cwd, or Codex args for full launch control. An existing bot reuses its saved workspace and args; [] clears args while stopped. A running bot rejects changed args or account assignment.",
  input: z.strictObject({
    id: botId.optional().describe("Existing or custom bot id. Omit to allocate the next bot-N."),
    cwd: z.string().optional().describe("Existing working directory override. Omit for a new private workspace or to reuse an existing bot's workspace. A supplied directory is never deleted by bot_remove."),
    args: z.array(z.string()).optional().describe("Extra Codex arguments retained for future launches. Omit to reuse saved args; [] clears them while stopped. AgentStack owns --listen, --identity, --capabilities, and --history-dir."),
  }),
  output: botView, annotations: { title: "Start bot" },
  async call(ctx: BotsContext, input) {
    const existing = input.id === undefined ? undefined : ctx.supervisor.list().find((bot) => bot.id === input.id);
    let id = input.id;
    if (!id) id = ctx.ledger.reserve(claimWorkspace(ctx.root, new Set(ctx.supervisor.list().map((bot) => bot.id)), input.cwd === undefined), input.cwd === undefined);
    let cwd: string;
    if (input.cwd !== undefined) cwd = resolve(input.cwd);
    else if (existing) cwd = existing.cwd;
    else if (ctx.ledger.has(id) || ctx.ledger.ownsWorkspace(id)) cwd = await ensureWorkspace(workspacePath(ctx.root, id));
    else {
      cwd = await claimNamedWorkspace(workspacePath(ctx.root, id));
      ctx.ledger.ownWorkspace(id);
    }
    return ctx.supervisor.start({ id, cwd, args: input.args });
  },
});
export const botAssign = operation({
  name: "bot_assign", description: "Assign a Codex account to an existing bot. A running bot keeps its launched identity until stopped and started again.",
  input: z.strictObject({ id: botId, account: z.uuid().describe("Codex account ID from account_list.") }),
  output: botView, annotations: { title: "Assign bot account", idempotentHint: true },
  async call(ctx: BotsContext, { id, account }) { return ctx.supervisor.assign(id, account); },
});
export const botStop = operation({
  name: "bot_stop", description: "Stop a known bot. Stopping an already stopped or never-started numbered bot succeeds.",
  input: z.strictObject({ id: botId }), output: botView,
  annotations: { title: "Stop bot", destructiveHint: true, idempotentHint: true },
  async call(ctx: BotsContext, { id }) {
    if (ctx.supervisor.list().some((bot) => bot.id === id)) return ctx.supervisor.stop(id);
    if (!ctx.ledger.has(id) && !ctx.ledger.ownsWorkspace(id)) throw new Error(`unknown bot: ${id}`);
    return { id, pid: null, cwd: workspacePath(ctx.root, id), url: null, state: "stopped" as const, account: null, runningAccount: null, mainThreadId: null, recoveryIssue: null, roleRevision: null };
  },
});
export const botRemove = operation({
  name: "bot_remove", description: "Stop and delete a bot record and private runtime. Delete its workspace when it is under the private bots root; never delete an external cwd.",
  input: z.strictObject({ id: botId }), output: z.strictObject({ id: botId }),
  annotations: { title: "Remove bot", destructiveHint: true },
  async call(ctx: BotsContext, { id }) {
    const existing = ctx.supervisor.list().find((bot) => bot.id === id);
    if (!existing && !ctx.ledger.has(id) && !ctx.ledger.ownsWorkspace(id)) throw new Error(`unknown bot: ${id}`);
    if (existing) await ctx.supervisor.remove(id);
    if (ctx.ledger.ownsWorkspace(id)) await rm(workspacePath(ctx.root, id), { recursive: true, force: true });
    ctx.ledger.forgetWorkspace(id);
    if (ctx.ledger.has(id)) ctx.ledger.remove(id);
    return { id };
  },
});
export const botList = operation({
  name: "bot_list", description: "List all recorded bots, including stopped ones and bots with custom IDs or working directories.",
  input: z.strictObject({}), output: z.object({ bots: z.array(botView) }),
  annotations: { title: "List bots", readOnlyHint: true },
  async call(ctx: BotsContext) { return { bots: ctx.supervisor.list() }; },
});

const sessionIdSchema = z.uuid().describe("Client-generated call ID, used to identify the exact call when hanging up.");
const voiceCallSchema = z.strictObject({ sessionId: sessionIdSchema, botId, threadId: z.string(), phase: z.enum(["dialing", "connected"]) });
export const voiceStatus = operation({
  name: "voice_status", description: "Read the single active voice call, if any. Calls belong to an existing bot's durable main thread; no new thread is created.",
  input: z.strictObject({}), output: z.strictObject({ call: voiceCallSchema.nullable() }),
  annotations: { title: "Voice call status", readOnlyHint: true },
  async call(ctx: BotsContext) { return { call: ctx.voice.status() }; },
});
export const voiceDial = operation({
  name: "voice_dial", description: "Start full-duplex WebRTC audio on a verified running bot's durable main thread. Supply a gathered SDP offer and a fresh client-generated UUID. One call is allowed across all bots.",
  input: z.strictObject({ botId, sessionId: sessionIdSchema, sdp: z.string().min(1).max(65_536).describe("Complete local WebRTC audio SDP offer, after ICE gathering.") }),
  output: z.strictObject({ sessionId: sessionIdSchema, answer: z.string().min(1).describe("Remote WebRTC SDP answer from Codex.") }),
  annotations: { title: "Dial voice" },
  async call(ctx: BotsContext, { botId, sessionId, sdp }) { return ctx.voice.dial(botId, sessionId, sdp); },
});
export const voiceHangup = operation({
  name: "voice_hangup", description: "End exactly this call. An already ended call succeeds; a stale ID cannot stop another active call. Does not stop the bot or its turns.",
  input: z.strictObject({ sessionId: sessionIdSchema }), output: z.strictObject({ call: voiceCallSchema.nullable() }),
  annotations: { title: "Hang up voice", idempotentHint: true },
  async call(ctx: BotsContext, { sessionId }) { return { call: await ctx.voice.hangup(sessionId) }; },
});

export const api: PackageApi<BotsContext, BotsTopic> = {
  operations: [botStart, botStop, botAssign, botRemove, botList, voiceStatus, voiceDial, voiceHangup],
  events: {
    topics,
    scope: {
      description: "Optional bot ID. Scoped subscriptions receive changes only for that bot; omit scope to receive global voice and bot notices.",
      example: "bot-1",
      valid: (ctx, scope) => ctx.ledger.has(scope) || ctx.ledger.ownsWorkspace(scope) || ctx.supervisor.list().some((bot) => bot.id === scope),
    },
    start(ctx, publish) {
      const watches = new Map<string, { url: string; stop: () => void }>();
      const sync = () => {
        const active = new Map(ctx.supervisor.list().flatMap((bot) => bot.state === "running" && !bot.recoveryIssue && bot.url ? [[bot.id, bot.url] as const] : []));
        for (const [id, watch] of watches) if (active.get(id) !== watch.url) { watch.stop(); watches.delete(id); }
        for (const [id, url] of active) if (!watches.has(id)) watches.set(id, { url, stop: watchThreadEvents(url, () => {
          publish("threads_changed", id);
          void ctx.supervisor.adoptMainThread(id, url).catch((error) => console.error(`failed to adopt main thread for ${id}: ${error}`));
        }) });
      };
      ctx.supervisor.onChange = (id) => { sync(); publish("bots_changed", id); };
      ctx.voice.onChange = () => publish("voice_changed");
      sync();
      return () => { ctx.supervisor.onChange = undefined; ctx.voice.onChange = undefined; for (const watch of watches.values()) watch.stop(); watches.clear(); };
    },
  },
  async createContext(env) {
    const dir = stateDir(env);
    const ownerMcpPort = env.AGENTSTACK_OWNER_MCP_PORT;
    if (ownerMcpPort !== undefined && (!/^[1-9][0-9]*$/.test(ownerMcpPort) || Number(ownerMcpPort) > 65535)) throw new Error("AGENTSTACK_OWNER_MCP_PORT must be a bound TCP port");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const store = new StateStore(dir);
    const root = resolve(join(dir, "bots"));
    const ledger = new BotLedger(root);
    const supervisor = new Supervisor({ stateDir: dir, store, mcpServers: ownerMcpPort === undefined ? undefined : (id, endpoint) => ownerMcpUrls(workspaceRoot(import.meta.dirname), Number(ownerMcpPort), id, endpoint, env) });
    await supervisor.load();
    await supervisor.reap();
    await supervisor.resumeAll();
    return { root, ledger, store, supervisor, voice: new VoiceCalls(() => supervisor.list()) };
  },
  async closeContext(ctx) {
    try { await ctx.voice.close(); }
    finally {
      await ctx.supervisor.stopAll();
      await ctx.supervisor.runtime.close();
      ctx.supervisor.role.close();
      ctx.ledger.close();
      ctx.store.close();
    }
  },
};
export type { ServerView };
