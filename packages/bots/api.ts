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
import { ChatIndex, ChatQueue, ChatUploads, chatRpc, live } from "./src/chats.js";

const botId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).describe("Bot id. Omit for the next bot-N; supply a name to override it.");
const botSettings = z.strictObject({
  model: z.string().min(1).describe("Codex model identifier. Default: gpt-6-sol."),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).describe("Codex model reasoning effort. Default: medium; the selected model must support it."),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).describe("Codex sandbox mode. Default: danger-full-access."),
  approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).describe("Codex approval policy. Default: never."),
});
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
  settings: botSettings.nullable().describe("Saved launch settings for this Bot, or null for a pre-existing Bot that retains Codex's implicit model and effort. Caller args can override settings at launch."),
});

export type BotsContext = { root: string; ledger: BotLedger; store: StateStore; supervisor: Supervisor; voice: VoiceCalls; chats: ChatIndex; queue: ChatQueue; uploads: ChatUploads };
export const topics = {
  bots_changed: "Published when a bot starts, stops, exits, changes assignment, or is fenced for recovery. Refresh bot_list.",
  threads_changed: "Published when loaded thread state for this bot changes or its Codex connection resumes. Read its app-server thread state.",
  voice_changed: "Published when the single voice call starts, connects, or ends. Refresh voice_status; the notice carries no SDP or audio.",
  defaults_changed: "Published when the defaults for newly created Bots change. Refresh bot_defaults_get.",
  chats_changed: "A Bot's Codex thread state changed or its chat history may have grown. Re-read chat_list, chat_thread_read or chat_turns; notices carry no transcript content.",
  chat_queue_changed: "A queued message changed admission or dispatch state. Refresh chat_queue_list for the Bot; notices carry no message content.",
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
  description: "Start a bot or return its live process. Omit id for the next bot-N and a private workspace. New bots copy bot_defaults_get settings and bind the active account. Optional settings override this Bot's saved launch settings; saved args follow and can override them. A running bot rejects changed settings, args, or account assignment; stop/start applies changes.",
  input: z.strictObject({
    id: botId.optional().describe("Existing or custom bot id. Omit to allocate the next bot-N."),
    cwd: z.string().optional().describe("Existing working directory override. Omit for a new private workspace or to reuse an existing bot's workspace. A supplied directory is never deleted by bot_remove."),
    args: z.array(z.string()).optional().describe("Extra Codex arguments retained for future launches. Omit to reuse saved args; [] clears them while stopped. AgentStack owns --listen, --identity, --capabilities, and --history-dir."),
    settings: botSettings.partial().optional().describe("Override defaults for a new Bot, or update saved settings of a stopped Bot. Omit to reuse its saved settings."),
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
    return ctx.supervisor.start({ id, cwd, args: input.args, settings: input.settings });
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
    return { id, pid: null, cwd: workspacePath(ctx.root, id), url: null, state: "stopped" as const, account: null, runningAccount: null, mainThreadId: null, recoveryIssue: null, roleRevision: null, settings: ctx.store.botDefaults() };
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
    ctx.chats.removeBot(id);
    await ctx.uploads.removeBot(id);
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

export const botDefaultsGet = operation({
  name: "bot_defaults_get", description: "Read the saved settings copied into newly created Bots. Changing them does not retune existing Bots.",
  input: z.strictObject({}), output: botSettings,
  annotations: { title: "Get bot defaults", readOnlyHint: true },
  async call(ctx: BotsContext) { return ctx.store.botDefaults(); },
});
export const botDefaultsSet = operation({
  name: "bot_defaults_set", description: "Change settings for Bots created after this call. Existing Bots retain their saved settings; bot_start can update a stopped Bot explicitly.",
  input: botSettings.partial(), output: botSettings,
  annotations: { title: "Set bot defaults", idempotentHint: true },
  async call(ctx: BotsContext, input) { return ctx.store.setBotDefaults(input); },
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

const threadId = z.uuid().describe("Codex thread ID in this Bot's sanctioned main-thread lineage.");
const page = { limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().nonnegative().default(0) };
const chatRow = z.strictObject({ botId, threadId, parentThreadId: threadId.nullable(), title: z.string(), cwd: z.string(), createdAt: z.string(), updatedAt: z.string(), messageCount: z.number().int() });
const raw = z.record(z.string(), z.unknown());
const codexPage = z.strictObject({ data: z.array(raw), nextCursor: z.string().nullable(), backwardsCursor: z.string().nullable().optional() });
const inputPart = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({ type: z.literal("image"), url: z.string().max(500_000).describe("Data URL or Codex-supported image URL. Large uploads should use Codex's file-upload transport directly.") }),
  z.strictObject({ type: z.literal("localImage"), path: z.string().min(1).describe("Finalized upload path or file inside the Bot workspace.") }),
  z.strictObject({ type: z.literal("localAudio"), path: z.string().min(1).describe("Finalized upload path or file inside the Bot workspace.") }),
  z.strictObject({ type: z.literal("mention"), name: z.string().min(1), path: z.string().min(1).describe("File reference, restricted to this Bot's workspace.") }),
]);
function botFor(ctx: BotsContext, id: string): ServerView {
  const bot = ctx.supervisor.list().find((item) => item.id === id);
  if (!bot) throw new Error(`unknown bot: ${id}`);
  return bot;
}
async function allowed(ctx: BotsContext, id: string, target: string): Promise<ServerView> {
  const bot = botFor(ctx, id);
  await ctx.chats.refresh(id, bot.mainThreadId);
  if (!ctx.chats.allowed(id, target, bot.mainThreadId)) throw new Error("thread is not in this Bot's main-thread lineage");
  return bot;
}
async function interactive(ctx: BotsContext, id: string, target: string): Promise<ServerView> {
  const bot = await allowed(ctx, id, target);
  if (bot.mainThreadId !== target) throw new Error("direct chat interaction is limited to this Bot's main thread; descendants are read-only");
  return bot;
}
async function inputParts(ctx: BotsContext, bot: ServerView, parts: z.infer<typeof inputPart>[]): Promise<Record<string, unknown>[]> {
  const { realpath } = await import("node:fs/promises");
  const cwd = await realpath(bot.cwd);
  return Promise.all(parts.map(async (part) => {
    if (part.type !== "mention" && part.type !== "localImage" && part.type !== "localAudio") return part;
    const { relative, resolve, isAbsolute } = await import("node:path");
    const absolute = await realpath(resolve(cwd, part.path));
    const rel = relative(cwd, absolute);
    if ((rel.startsWith("..") || isAbsolute(rel)) && !(await ctx.uploads.within(bot.id, absolute))) throw new Error("file input must refer to the Bot workspace or a finalized upload for this Bot");
    return { ...part, path: absolute };
  }));
}

export const chatList = operation({
  name: "chat_list", description: "List indexed Codex chats belonging to this Bot's sanctioned root (and its descendants). Includes stopped Bot history; refreshes the private rollout index before returning.",
  input: z.strictObject({ botId, ...page }), output: z.strictObject({ chats: z.array(chatRow) }), annotations: { title: "List chats", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, limit, offset }) { const bot = botFor(ctx, id); await ctx.chats.refresh(id, bot.mainThreadId); return { chats: ctx.chats.list(id, bot.mainThreadId, limit, offset) }; },
});
export const chatSearch = operation({
  name: "chat_search", description: "Full-text search over agentstack-owned Bot rollouts: user and assistant text, tool calls and outputs, and available reasoning summaries. Results rank chats by matching message, with a citeable rollout line and snippet. Only the sanctioned root and descendants are returned; scores are comparable only within one query.",
  input: z.strictObject({ botId, query: z.string().min(1).max(512), ...page }), output: z.strictObject({ hits: z.array(chatRow.extend({ line: z.number().int(), role: z.string(), snippet: z.string(), score: z.number() })) }), annotations: { title: "Search chats", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, query, limit, offset }) { const bot = botFor(ctx, id); await ctx.chats.refresh(id, bot.mainThreadId); return { hits: ctx.chats.search(id, bot.mainThreadId, query, limit, offset) }; },
});
export const chatRecords = operation({
  name: "chat_records", description: "Page raw Codex response items and events in rollout order, including fields not projected by thread/items/list. Works while stopped. Records over the response budget have null payload and truncated=true; fetch them with chat_record_chunk. nextLine is the continuation position.",
  input: z.strictObject({ botId, threadId, afterLine: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }),
  output: z.strictObject({ records: z.array(z.strictObject({ line: z.number().int(), timestamp: z.string(), type: z.string(), payload: z.unknown(), truncated: z.boolean() })), nextLine: z.number().int().nullable() }), annotations: { title: "Read chat records", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, afterLine, limit }) { const bot = await allowed(ctx, id, target); return ctx.chats.records(id, target, bot.mainThreadId, afterLine, limit); },
});
export const chatRecordChunk = operation({
  name: "chat_record_chunk", description: "Read a complete rollout record by line in bounded text chunks, including long tool outputs and image-bearing payloads. Offsets and lengths count UTF-16 code units; concatenate chunks for the original JSONL record.",
  input: z.strictObject({ botId, threadId, line: z.number().int().min(1), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(65_536).default(32_768) }),
  output: z.strictObject({ text: z.string(), totalChars: z.number().int(), nextOffset: z.number().int().nullable() }), annotations: { title: "Read full chat record", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, line, offset, length }) { const bot = await allowed(ctx, id, target); return ctx.chats.recordChunk(id, target, bot.mainThreadId, line, offset, length); },
});
export const chatThreadRead = operation({
  name: "chat_thread_read", description: "Read Codex's complete live thread metadata (including activity, model, lineage and capabilities). Turns are paged separately; never hydrates an unbounded transcript.",
  input: z.strictObject({ botId, threadId }), output: z.strictObject({ thread: raw }), annotations: { title: "Read chat thread", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target }) { const bot = await allowed(ctx, id, target); return z.strictObject({ thread: raw }).parse(await chatRpc(live(bot), "thread/read", { threadId: target })); },
});
export const chatTurns = operation({
  name: "chat_turns", description: "Page Codex turns with complete typed items and status, including tool calls and outputs. Cursors are native opaque values; re-read after chats_changed.",
  input: z.strictObject({ botId, threadId, cursor: z.string().optional(), limit: z.number().int().min(1).max(50).default(20), sortDirection: z.enum(["asc", "desc"]).default("desc") }),
  output: codexPage, annotations: { title: "Page chat turns", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, ...args }) { const bot = await allowed(ctx, id, target); return codexPage.parse(await chatRpc(live(bot), "thread/turns/list", { threadId: target, ...args, itemsView: "full" })); },
});
export const chatItems = operation({
  name: "chat_items", description: "Page Codex thread items in order, optionally within a turn. Preserves the native item shape and timing; use this rather than truncating a long turn.",
  input: z.strictObject({ botId, threadId, turnId: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) }),
  output: codexPage, annotations: { title: "Page chat items", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, ...args }) { const bot = await allowed(ctx, id, target); return codexPage.parse(await chatRpc(live(bot), "thread/items/list", { threadId: target, ...args })); },
});
export const chatSend = operation({
  name: "chat_send", description: "Start a Codex turn on a sanctioned live thread. Fails if Codex cannot accept it; an interrupted RPC may have started the turn, so inspect history before retrying. An active turn may be steered by Codex; use chat_steer for explicit expected-turn protection.",
  input: z.strictObject({ botId, threadId, input: z.array(inputPart).min(1), clientUserMessageId: z.uuid().optional(), model: z.string().optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional() }),
  output: z.strictObject({ turn: raw }), annotations: { title: "Send chat message" },
  async call(ctx: BotsContext, { botId: id, threadId: target, input, ...args }) { const bot = await interactive(ctx, id, target); return z.strictObject({ turn: raw }).parse(await chatRpc(live(bot), "turn/start", { threadId: target, input: await inputParts(ctx, bot, input), ...args })); },
});
export const chatOpen = operation({
  name: "chat_open", description: "Create the Bot's first durable main thread and start its first turn. An already adopted Bot rejects this; a lost response may have created the root or turn, so inspect bot_list and history before retrying.",
  input: z.strictObject({ botId, input: z.array(inputPart).min(1) }), output: z.strictObject({ threadId, turn: raw }), annotations: { title: "Open first chat" },
  async call(ctx: BotsContext, { botId: id, input }) {
    const bot = botFor(ctx, id);
    const result = await ctx.supervisor.openMainChat(id, await inputParts(ctx, bot, input));
    ctx.queue.wakeBot(id);
    return result;
  },
});
export const chatSteer = operation({
  name: "chat_steer", description: "Steer exactly the expected active Codex turn; rejects a changed or completed turn rather than sending to a different one.",
  input: z.strictObject({ botId, threadId, expectedTurnId: z.string().min(1), input: z.array(inputPart).min(1), clientUserMessageId: z.uuid().optional() }), output: z.strictObject({ turnId: z.string() }), annotations: { title: "Steer chat turn" },
  async call(ctx: BotsContext, { botId: id, threadId: target, input, ...args }) { const bot = await interactive(ctx, id, target); return z.strictObject({ turnId: z.string() }).parse(await chatRpc(live(bot), "turn/steer", { threadId: target, input: await inputParts(ctx, bot, input), ...args })); },
});
export const chatInterrupt = operation({
  name: "chat_interrupt", description: "Interrupt exactly this active turn. A stale turn ID cannot interrupt a newer turn.",
  input: z.strictObject({ botId, threadId, turnId: z.string().min(1) }), output: z.strictObject({}), annotations: { title: "Interrupt chat turn", destructiveHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, turnId }) { const bot = await interactive(ctx, id, target); await chatRpc(live(bot), "turn/interrupt", { threadId: target, turnId }); return {}; },
});
const queuedChat = z.strictObject({ id: z.uuid(), botId, threadId, input: z.array(z.unknown()), state: z.enum(["pending", "dispatching", "sent", "unknown", "cancelled"]), turnId: z.string().nullable(), issue: z.string().nullable() });
export const chatEnqueue = operation({
  name: "chat_enqueue", description: "Durably queue a message for a sanctioned thread. A client-generated UUID is the admission key; reusing it with different content fails. Dispatch waits for an idle turn. An uncertain dispatch blocks later messages until explicitly reconciled.",
  input: z.strictObject({ botId, threadId, id: z.uuid(), input: z.array(inputPart).min(1) }), output: queuedChat, annotations: { title: "Queue chat message", idempotentHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, id: key, input }) {
    const bot = await interactive(ctx, id, target);
    const prepared = await inputParts(ctx, bot, input);
    const item = ctx.chats.enqueue(id, target, key, prepared);
    ctx.queue.onChange?.(id);
    ctx.queue.wake(id, target);
    return item;
  },
});
export const chatQueueList = operation({
  name: "chat_queue_list", description: "Read durable queued messages and their exact admission/dispatch outcomes; unknown means inspect the thread before resolving, not retry.",
  input: z.strictObject({ botId, threadId }), output: z.strictObject({ entries: z.array(queuedChat) }), annotations: { title: "Read chat queue", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target }) { await allowed(ctx, id, target); return { entries: ctx.chats.queueList(id, target) }; },
});
export const chatQueueResolve = operation({
  name: "chat_queue_resolve", description: "Cancel a pending message before dispatch, or explicitly reconcile an unknown delivery after inspecting the Codex thread. A dispatching message cannot be cancelled safely; never treat silence as proof of non-delivery.",
  input: z.strictObject({ botId, threadId, id: z.uuid(), state: z.enum(["sent", "cancelled"]), turnId: z.string().optional() }), output: queuedChat, annotations: { title: "Resolve chat queue entry" },
  async call(ctx: BotsContext, { botId: id, threadId: target, id: key, state, turnId }) {
    await interactive(ctx, id, target);
    const item = ctx.chats.queued(key);
    if (!item || item.botId !== id || item.threadId !== target) throw new Error("unknown queued message for this thread");
    if (item.state !== "pending" && item.state !== "unknown") throw new Error("only pending or unknown queue entries can be resolved");
    if (item.state === "pending" && state !== "cancelled") throw new Error("a pending message cannot be marked sent");
    if (state === "sent" && !turnId) throw new Error("supply the observed Codex turn ID when reconciling delivery");
    const result = ctx.chats.setQueued(key, state, turnId ?? null);
    ctx.queue.onChange?.(id);
    ctx.queue.wake(id, target);
    return result;
  },
});
const codexSubmission = z.strictObject({ id: z.string(), input: z.array(z.unknown()), clientUserMessageId: z.string() });
export const chatCodexQueueAdd = operation({
  name: "chat_codex_queue_add", description: "Put a message in Codex's own durable, manually started queue. Unlike chat_enqueue, Codex will not automatically dispatch it. After an uncertain RPC, list the native queue by clientUserMessageId before retrying.",
  input: z.strictObject({ botId, threadId, clientUserMessageId: z.uuid(), input: z.array(inputPart).min(1) }), output: z.strictObject({ queuedSubmission: codexSubmission }), annotations: { title: "Add native queued message" },
  async call(ctx: BotsContext, { botId: id, threadId: target, input, clientUserMessageId }) { const bot = await interactive(ctx, id, target); return z.strictObject({ queuedSubmission: codexSubmission }).parse(await chatRpc(live(bot), "thread/queue/add", { threadId: target, clientUserMessageId, input: await inputParts(ctx, bot, input) })); },
});
export const chatCodexQueueList = operation({
  name: "chat_codex_queue_list", description: "Page the native Codex queue for a sanctioned thread, including submissions created by other connected clients.",
  input: z.strictObject({ botId, threadId, cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(25) }), output: z.strictObject({ data: z.array(codexSubmission), nextCursor: z.string().nullable() }), annotations: { title: "List native queued messages", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, ...args }) { const bot = await allowed(ctx, id, target); return z.strictObject({ data: z.array(codexSubmission), nextCursor: z.string().nullable() }).parse(await chatRpc(live(bot), "thread/queue/list", { threadId: target, ...args })); },
});
export const chatCodexQueueUpdate = operation({
  name: "chat_codex_queue_update", description: "Replace input for one native queued submission; retains its identity and client message ID.",
  input: z.strictObject({ botId, threadId, queuedSubmissionId: z.string().min(1), input: z.array(inputPart).min(1) }), output: z.strictObject({ queuedSubmission: codexSubmission }), annotations: { title: "Edit native queued message" },
  async call(ctx: BotsContext, { botId: id, threadId: target, input, queuedSubmissionId }) { const bot = await interactive(ctx, id, target); return z.strictObject({ queuedSubmission: codexSubmission }).parse(await chatRpc(live(bot), "thread/queue/update", { threadId: target, queuedSubmissionId, input: await inputParts(ctx, bot, input) })); },
});
export const chatCodexQueueDelete = operation({
  name: "chat_codex_queue_delete", description: "Remove one not-yet-started native queued submission.",
  input: z.strictObject({ botId, threadId, queuedSubmissionId: z.string().min(1) }), output: z.strictObject({ deleted: z.boolean() }), annotations: { title: "Remove native queued message", destructiveHint: true, idempotentHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, queuedSubmissionId }) { const bot = await interactive(ctx, id, target); return z.strictObject({ deleted: z.boolean() }).parse(await chatRpc(live(bot), "thread/queue/delete", { threadId: target, queuedSubmissionId })); },
});
export const chatCodexQueueReorder = operation({
  name: "chat_codex_queue_reorder", description: "Set the exact order of Codex's native queued submissions for this thread.",
  input: z.strictObject({ botId, threadId, queuedSubmissionIds: z.array(z.string().min(1)) }), output: z.strictObject({}), annotations: { title: "Reorder native queued messages" },
  async call(ctx: BotsContext, { botId: id, threadId: target, queuedSubmissionIds }) { const bot = await interactive(ctx, id, target); await chatRpc(live(bot), "thread/queue/reorder", { threadId: target, queuedSubmissionIds }); return {}; },
});
export const chatCodexQueueStart = operation({
  name: "chat_codex_queue_start", description: "Start a queued native message if Codex is idle. A lost response is an unknown outcome; inspect turns and native queue before retrying.",
  input: z.strictObject({ botId, threadId, queuedSubmissionId: z.string().optional() }), output: z.strictObject({ turn: raw }), annotations: { title: "Start native queued message" },
  async call(ctx: BotsContext, { botId: id, threadId: target, queuedSubmissionId }) { const bot = await interactive(ctx, id, target); return z.strictObject({ turn: raw }).parse(await chatRpc(live(bot), "thread/queue/start", { threadId: target, ...(queuedSubmissionId ? { queuedSubmissionId } : {}) })); },
});
export const chatOccurrences = operation({
  name: "chat_occurrences", description: "Page Codex's precise visible-message matches within a sanctioned thread; each occurrence supplies turn and item IDs, an exact highlighted snippet range, and a turn cursor for opening context.",
  input: z.strictObject({ botId, threadId, query: z.string().min(1).max(512), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(25) }), output: z.strictObject({ data: z.array(raw), nextCursor: z.string().nullable() }), annotations: { title: "Find within a chat", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, query, ...args }) { const bot = await allowed(ctx, id, target); return z.strictObject({ data: z.array(raw), nextCursor: z.string().nullable() }).parse(await chatRpc(live(bot), "thread/searchOccurrences", { threadId: target, searchTerm: query, ...args })); },
});
const upload = z.strictObject({ botId, id: z.uuid(), name: z.string(), bytes: z.number().int().min(1).max(20_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative(), path: z.string().nullable() });
export const chatUploadStart = operation({
  name: "chat_upload_start", description: "Start or inspect a Bot-private file upload by UUID, filename, exact byte length and SHA-256. Use chunk/status/finish to stage files for localImage, localAudio, or mention inputs. Maximum 20 MB.",
  input: z.strictObject({ botId, id: z.uuid(), name: z.string().min(1).max(200), bytes: z.number().int().min(1).max(20_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }), output: upload, annotations: { title: "Start chat file upload", idempotentHint: true },
  async call(ctx: BotsContext, { botId: id, ...args }) { botFor(ctx, id); return ctx.uploads.start(id, args.id, args.name, args.bytes, args.sha256); },
});
export const chatUploadStatus = operation({
  name: "chat_upload_status", description: "Read the actual byte offset after any interrupted chunk request. A finalized upload returns its stable local path.",
  input: z.strictObject({ botId, id: z.uuid() }), output: upload, annotations: { title: "Read chat file upload", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, id: key }) { botFor(ctx, id); return ctx.uploads.status(id, key); },
});
export const chatUploadChunk = operation({
  name: "chat_upload_chunk", description: "Append up to 256 KiB of canonical base64 at an exact expected offset. Read status before retrying an uncertain acknowledgement.",
  input: z.strictObject({ botId, id: z.uuid(), offset: z.number().int().nonnegative(), data: z.string().min(1).max(350_000) }), output: upload, annotations: { title: "Upload chat file chunk" },
  async call(ctx: BotsContext, { botId: id, id: key, offset, data }) { botFor(ctx, id); return ctx.uploads.append(id, key, offset, data); },
});
export const chatUploadFinish = operation({
  name: "chat_upload_finish", description: "Verify byte length and SHA-256, publish the Bot-private local path and return it for chat input. Uploads are removed with their Bot.",
  input: z.strictObject({ botId, id: z.uuid() }), output: upload, annotations: { title: "Finish chat file upload", idempotentHint: true },
  async call(ctx: BotsContext, { botId: id, id: key }) { botFor(ctx, id); return ctx.uploads.finish(id, key); },
});
const attachment = z.strictObject({ id: z.string(), attachmentType: z.string(), identityKey: z.string(), payload: z.unknown(), createdAt: z.number().int() });
export const chatAttachmentAdd = operation({
  name: "chat_attachment_add", description: "Associate an idempotently keyed Codex attachment record with a sanctioned live thread. This persists metadata, not file bytes; upload file bytes with chat_upload_* first.",
  input: z.strictObject({ botId, threadId, attachmentType: z.string().min(1), identityKey: z.string().min(1), payload: raw }),
  output: z.strictObject({ outcome: z.enum(["created", "existing"]), attachment }), annotations: { title: "Add chat attachment" },
  async call(ctx: BotsContext, { botId: id, threadId: target, ...args }) { const bot = await interactive(ctx, id, target); return z.strictObject({ outcome: z.enum(["created", "existing"]), attachment }).parse(await chatRpc(live(bot), "thread/attachment/add", { threadId: target, ...args })); },
});
export const chatAttachmentList = operation({
  name: "chat_attachment_list", description: "Page Codex's persisted attachment records for a sanctioned thread.",
  input: z.strictObject({ botId, threadId, cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(25) }),
  output: z.strictObject({ data: z.array(attachment), nextCursor: z.string().nullable() }), annotations: { title: "List chat attachments", readOnlyHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, ...args }) { const bot = await allowed(ctx, id, target); return z.strictObject({ data: z.array(attachment), nextCursor: z.string().nullable() }).parse(await chatRpc(live(bot), "thread/attachment/list", { threadId: target, ...args })); },
});
export const chatAttachmentRemove = operation({
  name: "chat_attachment_remove", description: "Remove a keyed attachment association from the Codex thread; does not delete uploaded file bytes.",
  input: z.strictObject({ botId, threadId, attachmentType: z.string().min(1), identityKey: z.string().min(1) }), output: z.strictObject({}), annotations: { title: "Remove chat attachment", destructiveHint: true },
  async call(ctx: BotsContext, { botId: id, threadId: target, ...args }) { const bot = await interactive(ctx, id, target); await chatRpc(live(bot), "thread/attachment/remove", { threadId: target, ...args }); return {}; },
});

export const api: PackageApi<BotsContext, BotsTopic> = {
  operations: [botStart, botStop, botAssign, botRemove, botList, botDefaultsGet, botDefaultsSet, voiceStatus, voiceDial, voiceHangup, chatList, chatSearch, chatRecords, chatRecordChunk, chatThreadRead, chatTurns, chatItems, chatOccurrences, chatOpen, chatSend, chatSteer, chatInterrupt, chatEnqueue, chatQueueList, chatQueueResolve, chatCodexQueueAdd, chatCodexQueueList, chatCodexQueueUpdate, chatCodexQueueDelete, chatCodexQueueReorder, chatCodexQueueStart, chatUploadStart, chatUploadStatus, chatUploadChunk, chatUploadFinish, chatAttachmentAdd, chatAttachmentList, chatAttachmentRemove],
  events: {
    topics,
    scope: {
      description: "Optional bot ID. Scoped subscriptions receive changes only for that bot; omit scope to receive global voice, defaults, and bot notices.",
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
          publish("chats_changed", id);
          ctx.queue.wakeBot(id);
          void ctx.supervisor.adoptMainThread(id, url).catch((error) => console.error(`failed to adopt main thread for ${id}: ${error}`));
        }) });
      };
      ctx.supervisor.onChange = (id) => { sync(); publish("bots_changed", id); };
      ctx.store.onDefaultsChange = () => publish("defaults_changed");
      ctx.voice.onChange = () => publish("voice_changed");
      ctx.queue.onChange = (id) => publish("chat_queue_changed", id);
      sync();
      for (const bot of ctx.supervisor.list()) ctx.queue.wakeBot(bot.id);
      return () => { ctx.supervisor.onChange = undefined; ctx.store.onDefaultsChange = undefined; ctx.voice.onChange = undefined; ctx.queue.onChange = undefined; for (const watch of watches.values()) watch.stop(); watches.clear(); };
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
    const chats = new ChatIndex(dir);
    return { root, ledger, store, supervisor, voice: new VoiceCalls(() => supervisor.list()), chats, queue: new ChatQueue(chats, (id) => supervisor.list().find((bot) => bot.id === id)), uploads: new ChatUploads(dir) };
  },
  async closeContext(ctx) {
    try { await ctx.voice.close(); }
    finally {
      await ctx.queue.close();
      await ctx.supervisor.stopAll();
      await ctx.supervisor.runtime.close();
      ctx.supervisor.role.close();
      ctx.ledger.close();
      ctx.store.close();
      ctx.chats.close();
    }
  },
};
export type { ServerView };
