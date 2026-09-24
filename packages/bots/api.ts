import { lstatSync, mkdirSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { operation, socketCall, socketPath, socketSubscribe, type PackageApi, type SocketSubscription } from "@agentstack/api";
import { serverList, serverStart, serverStop, type ServerView } from "@agentstack/codex";
import { BotLedger } from "./src/ledger.js";

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;

const botIdSchema = z
  .string()
  .regex(/^bot-[1-9][0-9]*$/)
  .describe("Bot id.");

export type BotsContext = {
  root: string;
  codexSocket: string;
  ledger: BotLedger;
  watchBot?: (id: string) => void;
  unwatchBot?: (id: string) => void;
};

export const topics = {
  bots_changed: "Published when this bot's Codex Server starts, stops, exits, or is reaped. Refresh bot_list.",
  threads_changed: "Published when loaded thread state for this bot changes or its Codex connection resumes. Read its app-server thread state.",
} as const;

export type BotsTopic = keyof typeof topics;

function watchBot(ctx: BotsContext, id: string, publish: (topic: BotsTopic, scope: string) => void): () => void {
  let stopped = false;
  let owned = false;
  let subscription: SocketSubscription | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  let refresh = Promise.resolve();
  const checkOwnership = () => {
    refresh = refresh.then(async () => {
      const servers = await codexServers(ctx);
      const wasOwned = owned;
      owned = servers.some((server) => server.id === id && server.cwd === workspacePath(ctx.root, id));
      if (!stopped && (owned || wasOwned)) publish("bots_changed", id);
      if (!stopped && owned) {
        publish("threads_changed", id);
      }
    }).catch(() => undefined);
  };
  const connect = async () => {
    if (stopped) return;
    try {
      const current = await socketSubscribe(
        ctx.codexSocket,
        ["servers_changed", "threads_changed"],
        (topic) => {
          if (stopped) return;
          if (topic === "servers_changed") checkOwnership();
          else if (owned) publish(topic as BotsTopic, id);
        },
        { scope: id, signal: abort.signal },
      );
      if (stopped) { await current.close(); return; }
      subscription = current;
      // Notices are invalidations, not a replay. Refresh after every (re)subscription.
      checkOwnership();
      void current.closed.then(() => {
        if (subscription === current) subscription = undefined;
        schedule();
      });
    } catch {
      schedule();
    }
  };
  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = undefined; void connect(); }, 1_000);
    retry.unref();
  };
  void connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    abort.abort();
    void subscription?.close();
  };
}

function workspacePath(root: string, id: string): string {
  return join(root, id);
}

async function codexServers(ctx: BotsContext): Promise<ServerView[]> {
  const result = await socketCall(ctx.codexSocket, "tools/call", { name: "server_list", arguments: {} });
  return serverList.output.parse(result).servers;
}

function claimWorkspace(root: string, taken: Set<string>): (id: string) => boolean {
  return (id) => {
    if (taken.has(id)) return false;
    const path = workspacePath(root, id);
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      mkdirSync(path, { mode: 0o700 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
}

async function ensureWorkspace(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info === undefined) {
    await mkdir(path, { mode: 0o700 });
    return path;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`bot workspace is not a directory: ${path}`);
  return path;
}

export const botStart = operation({
  name: "bot_start",
  description:
    "Start a Codex bot app-server in its private workspace, or return the live one. Omit id to allocate the next never-reused bot-N id. Omit args to reuse saved args; pass [] to clear them while stopped. A running Bot rejects changed args.",
  input: z.strictObject({
    id: botIdSchema.optional().describe("Existing bot id to restart. A new id is allocated when omitted."),
    args: z.array(z.string()).optional().describe("Extra Codex arguments saved for future launches. Omit to reuse saved args; [] clears them when stopped. Do not include --listen."),
  }),
  output: serverStart.output,
  annotations: { title: "Start bot" },
  async call(ctx: BotsContext, input) {
    let id = input.id;
    if (id === undefined) {
      const taken = new Set((await codexServers(ctx).catch(() => [])).map((server) => server.id));
      id = ctx.ledger.reserve(claimWorkspace(ctx.root, taken));
      ctx.watchBot?.(id);
    } else if (!ctx.ledger.has(id)) {
      throw new Error(`unknown bot: ${id}`);
    }
    const cwd = await ensureWorkspace(workspacePath(ctx.root, id));
    const server = serverStart.output.parse(
      await socketCall(
        ctx.codexSocket,
        "tools/call",
        { name: "server_start", arguments: { id, cwd, args: input.args } },
        { timeoutMs: START_TIMEOUT_MS },
      ),
    );
    if (server.id !== id || server.cwd !== cwd) {
      throw new Error(`codex server ${server.id} at ${server.cwd} is not bot ${id}`);
    }
    return server;
  },
});

export const botStop = operation({
  name: "bot_stop",
  description: "Stop a known bot's Codex app-server. Stopping an already stopped or never-started bot succeeds.",
  input: z.strictObject({
    id: botIdSchema.describe("Bot id to stop."),
  }),
  output: serverStop.output,
  annotations: { title: "Stop bot", destructiveHint: true, idempotentHint: true },
  async call(ctx: BotsContext, { id }) {
    if (!ctx.ledger.has(id)) throw new Error(`unknown bot: ${id}`);
    const cwd = workspacePath(ctx.root, id);
    const existing = (await codexServers(ctx)).find((server) => server.id === id);
    if (existing && existing.cwd !== cwd) throw new Error(`codex server ${id} does not use the ${id} workspace`);
    if (!existing) return { id, pid: null, cwd, url: null, state: "stopped" as const, account: null, mainThreadId: null };
    const server = serverStop.output.parse(
      await socketCall(ctx.codexSocket, "tools/call", { name: "server_stop", arguments: { id } }, { timeoutMs: STOP_TIMEOUT_MS }),
    );
    if (server.id !== id || server.cwd !== cwd) {
      throw new Error(`codex server ${server.id} at ${server.cwd} is not bot ${id}`);
    }
    return server;
  },
});

export const botRemove = operation({
  name: "bot_remove",
  description: "Stop and delete a bot Server, its private workspace, and its ledger record.",
  input: z.strictObject({ id: botIdSchema }), output: z.strictObject({ id: botIdSchema }),
  annotations: { title: "Remove bot", destructiveHint: true },
  async call(ctx: BotsContext, { id }) {
    if (!ctx.ledger.has(id)) throw new Error(`unknown bot: ${id}`);
    const cwd = workspacePath(ctx.root, id);
    const existing = (await codexServers(ctx)).find((server) => server.id === id);
    if (existing && existing.cwd !== cwd) throw new Error(`codex server ${id} does not use the ${id} workspace`);
    if (existing) await socketCall(ctx.codexSocket, "tools/call", { name: "server_remove", arguments: { id } }, { timeoutMs: STOP_TIMEOUT_MS });
    await rm(cwd, { recursive: true, force: true });
    ctx.ledger.remove(id);
    ctx.unwatchBot?.(id);
    return { id };
  },
});

export const botList = operation({
  name: "bot_list",
  description: "List recorded bots, including stopped ones. Each bot runs Codex in its own workspace under the agentstack state bots directory.",
  input: z.strictObject({}),
  output: z.object({
    bots: z.array(serverStart.output).describe("Recorded bots with a matching Codex app-server record."),
  }),
  annotations: { title: "List bots", readOnlyHint: true },
  async call(ctx: BotsContext) {
    const known = new Set(ctx.ledger.ids());
    const servers = await codexServers(ctx);
    return { bots: servers.filter((server) => known.has(server.id) && server.cwd === workspacePath(ctx.root, server.id)) };
  },
});

export const api: PackageApi<BotsContext, BotsTopic> = {
  operations: [botStart, botStop, botRemove, botList],
  events: {
    topics,
    scope: {
      description: "Required bot ID. Only changes to that bot are delivered on this subscription.",
      example: "bot-1",
      required: true,
      valid: (ctx, scope) => ctx.ledger.has(scope),
    },
    start(ctx, publish) {
      const watches = new Map<string, () => void>();
      ctx.watchBot = (id) => {
        if (!watches.has(id)) watches.set(id, watchBot(ctx, id, publish));
      };
      ctx.unwatchBot = (id) => {
        watches.get(id)?.();
        watches.delete(id);
      };
      for (const id of ctx.ledger.ids()) ctx.watchBot(id);
      return () => {
        ctx.watchBot = undefined;
        ctx.unwatchBot = undefined;
        for (const stop of watches.values()) stop();
        watches.clear();
      };
    },
  },
  async createContext(env) {
    const stateDir = env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack");
    const root = resolve(join(stateDir, "bots"));
    return { root, codexSocket: socketPath("codex", env), ledger: new BotLedger(root) };
  },
  async closeContext(ctx) {
    ctx.ledger.close();
  },
};
