import { lstatSync, mkdirSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { operation, socketCall, socketPath, type PackageApi } from "@agentstack/api";
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
};

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
    "Start a Codex bot app-server in its private workspace under the agentstack state bots directory, or return the live one. Omit id to allocate the next never-reused bot-N id. Extra args pass through to Codex.",
  input: z.strictObject({
    id: botIdSchema.optional().describe("Existing bot id to restart. A new id is allocated when omitted."),
    args: z.array(z.string()).optional().describe("Extra Codex arguments. Do not include --listen."),
  }),
  output: serverStart.output,
  annotations: { title: "Start bot" },
  async call(ctx: BotsContext, input) {
    let id = input.id;
    if (id === undefined) {
      const taken = new Set((await codexServers(ctx).catch(() => [])).map((server) => server.id));
      id = ctx.ledger.reserve(claimWorkspace(ctx.root, taken));
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

export const api: PackageApi<BotsContext> = {
  operations: [botStart, botStop, botList],
  async createContext(env) {
    const stateDir = env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack");
    const root = resolve(join(stateDir, "bots"));
    return { root, codexSocket: socketPath("codex", env), ledger: new BotLedger(root) };
  },
  async closeContext(ctx) {
    ctx.ledger.close();
  },
};
