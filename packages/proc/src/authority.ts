import { botInstance, currentMcpCatalog, socketCall, socketPath, workspaceRoot, type InvocationContext } from "@stack/api";
import { operator, type Actor, type Authority, type Action } from "./schema.js";

type Bot = { id: string; state: string; url: string | null; mainThreadId: string | null; recoveryIssue: string | null };
export class AuthorityBlocked extends Error {
  constructor(readonly reason: string, readonly retryMs: number | null = 30_000) { super(reason); }
}

/** Ownership is rooted in the durable Bot thread, not the replaceable runtime instance. */
export function owns(actor: Authority, owner: Actor | null): void {
  if (actor.kind === "operator") return;
  if (actor.kind !== "bot" || owner?.kind !== "bot" || actor.botId !== owner.botId || actor.mainThreadId !== owner.mainThreadId)
    throw new Error("proc_record_not_owned");
}

export class ProcAuthority {
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly root = workspaceRoot(import.meta.dirname)) {}

  private async bot(id: string): Promise<Bot> {
    let result: { bots: Bot[] };
    try {
      result = await socketCall(socketPath("bots", this.env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 2_000 }) as typeof result;
    } catch { throw new AuthorityBlocked("bot_service_unavailable"); }
    const bot = result.bots.find((bot) => bot.id === id);
    if (!bot) throw new AuthorityBlocked("bot_removed", null);
    return bot;
  }

  private live(bot: Bot, authority?: Extract<Authority, { kind: "bot" }>, instance?: string): string {
    if (authority && bot.mainThreadId !== authority.mainThreadId) throw new AuthorityBlocked("bot_root_changed", null);
    if (bot.state !== "running" || bot.recoveryIssue || !bot.url || !bot.mainThreadId) throw new AuthorityBlocked("bot_not_running");
    const current = botInstance(bot.url);
    if (instance && instance !== current) throw new AuthorityBlocked("bot_instance_changed");
    return current;
  }

  async resolve(authority: Authority, instance?: string): Promise<string | null> {
    if (authority.kind !== "bot") return null;
    const bot = await this.bot(authority.botId);
    const current = this.live(bot, authority, instance);
    try {
      // Bots owns lineage validation and reads only thread metadata, never transcripts.
      await socketCall(socketPath("bots", this.env), "tools/call", {
        name: "chat_thread_read", arguments: { botId: authority.botId, threadId: authority.threadId },
      }, { timeoutMs: 5_000 });
    } catch { throw new AuthorityBlocked("bot_thread_unavailable"); }
    this.live(await this.bot(authority.botId), authority, current);
    return current;
  }

  async actor(invocation?: InvocationContext): Promise<Authority> {
    if (invocation?.transport === "proc") throw new Error("recursive_schedule_refused");
    if (invocation?.workerId || invocation?.workerInstance) throw new Error("proc_requires_operator_or_bot");
    if (!invocation?.botId) {
      if (invocation?.instance) throw new Error("proc_invalid_caller");
      return operator;
    }
    if (!invocation.instance || !invocation.threadId) throw new Error("proc_requires_verified_bot_thread");
    const bot = await this.bot(invocation.botId);
    this.live(bot, undefined, invocation.instance);
    const authority: Authority = { kind: "bot", botId: bot.id, mainThreadId: bot.mainThreadId!, threadId: invocation.threadId };
    await this.resolve(authority, invocation.instance);
    return authority;
  }

  async target(action: Action, authority: Authority): Promise<void> {
    if (action.type !== "api") return;
    if (action.package === "proc") throw new AuthorityBlocked("recursive_schedule_refused", null);
    if (authority.kind === "bot") {
      let catalog;
      try { catalog = await currentMcpCatalog(this.root, action.package, this.env); }
      catch { throw new AuthorityBlocked("target_mcp_unavailable"); }
      if (!catalog.tools.some((tool) => tool.name === action.operation)) throw new AuthorityBlocked("target_not_mcp_exposed");
    } else {
      let catalog: { tools?: Array<{ name: string }> };
      try { catalog = await socketCall(socketPath(action.package, this.env), "tools/list", {}, { timeoutMs: 5_000 }) as typeof catalog; }
      catch { throw new AuthorityBlocked("target_unavailable"); }
      if (!catalog.tools?.some((tool) => tool.name === action.operation)) throw new AuthorityBlocked("target_operation_unavailable");
    }
  }
}
