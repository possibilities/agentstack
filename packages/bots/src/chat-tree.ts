import { createHash } from "node:crypto";
import { z } from "zod";
import { ChatIndex } from "./chats.js";
import { object, parent, spawnSource, string, uuid, type RecordValue } from "./chat-metadata.js";
import { withAppServer } from "./threads.js";
import type { ServerView } from "./supervisor.js";

const nullable = z.string().nullable();
export const chatTreeRow = z.strictObject({
  botId: z.string(), threadId: z.uuid(), parentThreadId: z.uuid().nullable(), depth: z.number().int().nonnegative(),
  name: nullable, preview: z.string(), agentNickname: nullable, agentRole: nullable, agentPath: nullable,
  model: nullable, reasoningEffort: nullable, modelProvider: nullable,
  configurationSource: z.enum(["nativeLoaded", "nativePersisted", "rollout", "unknown"]), configurationAt: nullable,
  status: z.strictObject({ type: z.enum(["active", "idle", "notLoaded", "systemError", "unknown"]), activeFlags: z.array(z.string()), freshness: z.enum(["live", "unknown"]) }),
  loaded: z.boolean().nullable(), cwd: nullable, createdAt: nullable, updatedAt: nullable,
  sessionId: nullable, forkedFromId: nullable, source: nullable, threadSource: nullable,
  originator: nullable, cliVersion: nullable, historyMode: nullable, ephemeral: z.boolean().nullable(),
  archived: z.boolean().nullable(), projectId: nullable,
  sources: z.array(z.enum(["rollout", "native"])), metadataTruncated: z.boolean(),
});
export type ChatTreeRow = z.infer<typeof chatTreeRow>;
export const chatTreeCoverage = z.strictObject({
  history: z.enum(["scanned", "unavailable"]).describe("Private rollout scan, not an authoritative native current-history pointer. For multiple same-thread rollouts, the latest modified file is selected; inherited history_base files are not replayed. Native reads are authoritative while running."), native: z.enum(["scanned", "partial", "unavailable", "stopped"]),
  issues: z.array(z.string()),
});
export const chatTreePage = z.strictObject({
  rootThreadId: z.uuid().nullable(), rows: z.array(chatTreeRow), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nullable(), snapshot: z.string(), observedAt: z.string(), coverage: chatTreeCoverage,
});
type Rpc = (method: string, params: RecordValue) => Promise<unknown>;
type Node = { parent: string | null | undefined; historical?: ReturnType<ChatIndex["treeRows"]>[number]; native?: RecordValue; archived?: boolean };
export type TreeSnapshot = { rootThreadId: string | null; rows: ChatTreeRow[]; snapshot: string; observedAt: string; coverage: z.infer<typeof chatTreeCoverage>; native: Map<string, RecordValue> };
const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

/** One bounded native sweep, including unloaded and archived threads and live-before-rollout children. */
export async function readChatTree(index: ChatIndex, bot: ServerView, maxThreads = 2000, rpc?: Rpc): Promise<TreeSnapshot> {
  const coverage: TreeSnapshot["coverage"] = { history: "scanned", native: "stopped", issues: [] };
  const nodes = new Map<string, Node>();
  try {
    await index.refresh(bot.id, bot.mainThreadId);
    for (const historical of index.treeRows(bot.id)) nodes.set(historical.threadId, { parent: historical.parentThreadId, historical });
  } catch { coverage.history = "unavailable"; coverage.issues.push("history_scan_failed"); }
  // The durable root binding itself is authority, even when its rollout is unavailable.
  if (bot.mainThreadId && !nodes.has(bot.mainThreadId)) nodes.set(bot.mainThreadId, { parent: null });
  const running = bot.state === "running" && !!bot.url && !bot.recoveryIssue && !!bot.runningAccount;
  const collect = async (call: Rpc) => {
    coverage.native = "scanned";
    const accept = (value: unknown, archived?: boolean) => {
      const record = object(value);
      if (!uuid(record.id)) { coverage.issues.push("invalid_native_thread"); return; }
      const old = nodes.get(record.id);
      const parentId = parent(record, true);
      // Conflicting independent lineage evidence never widens authority.
      const conflict = (old?.historical || old?.native) && old.parent !== parentId;
      if (conflict || parentId === undefined) coverage.issues.push("native_lineage_conflict");
      nodes.set(record.id, { ...old, parent: conflict ? undefined : parentId, native: record, archived: archived ?? old?.archived });
    };
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      let count = 0;
      let pages = 0;
      try {
        do {
          const response = object(await call("thread/list", { cursor, limit: Math.min(100, maxThreads - count), modelProviders: [], sourceKinds, archived }));
          if (!Array.isArray(response.data)) throw new Error("invalid thread list");
          for (const value of response.data.slice(0, maxThreads - count)) accept(value, archived);
          count += response.data.length;
          pages++;
          cursor = string(response.nextCursor);
          if (cursor && (count >= maxThreads || pages >= Math.ceil(maxThreads / 100) || seen.has(cursor))) { coverage.issues.push("native_history_limit"); break; }
          if (cursor) seen.add(cursor);
        } while (cursor);
      } catch { coverage.issues.push("native_history_read_failed"); }
    }
    let cursor: string | null = null;
    const seen = new Set<string>();
    const ids = new Set<string>();
    let pages = 0;
    try {
      do {
        const response = object(await call("thread/loaded/list", { cursor, limit: Math.min(100, maxThreads - ids.size) }));
        if (!Array.isArray(response.data)) throw new Error("invalid loaded list");
        for (const value of response.data) if (uuid(value) && ids.size < maxThreads) ids.add(value);
        pages++;
        cursor = string(response.nextCursor);
        if (cursor && (ids.size >= maxThreads || pages >= Math.ceil(maxThreads / 100) || seen.has(cursor))) { coverage.issues.push("native_loaded_limit"); break; }
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch { coverage.issues.push("native_loaded_read_failed"); }
    const pending = [...ids];
    // Reuse one connection; bounded concurrency also covers missing historical parents.
    for (let start = 0; start < pending.length; start += 8) await Promise.all(pending.slice(start, start + 8).map(async (id) => {
      try {
        const record = object(object(await call("thread/read", { threadId: id, includeTurns: false })).thread);
        if (record.id !== id) throw new Error("thread identity mismatch");
        accept(record);
      } catch { coverage.issues.push("native_thread_read_failed"); }
    }));
    if (coverage.issues.some((issue) => issue.startsWith("native_") || issue === "invalid_native_thread")) coverage.native = "partial";
  };
  if (running && bot.mainThreadId) {
    try { if (rpc) await collect(rpc); else await withAppServer(bot.url!, collect); }
    catch { coverage.native = "unavailable"; coverage.issues.push("native_connection_failed"); }
  } else if (bot.state === "running") { coverage.native = "unavailable"; coverage.issues.push("native_not_available"); }

  const rows: ChatTreeRow[] = [];
  const native = new Map<string, RecordValue>();
  for (const [id, node] of nodes) {
    let ancestor: string | null | undefined = id;
    const visited = new Set<string>();
    while (ancestor && ancestor !== bot.mainThreadId && !visited.has(ancestor)) {
      visited.add(ancestor); ancestor = nodes.get(ancestor)?.parent;
    }
    if (!bot.mainThreadId || ancestor !== bot.mainThreadId) continue;
    const value = node.native ?? {};
    const persisted = node.historical?.metadata ?? {};
    let metadataTruncated = persisted.truncated === true;
    const bounded = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      if (v.length > 1024) metadataTruncated = true;
      return v.slice(0, 1024);
    };
    const field = (key: string) => bounded(Object.hasOwn(value, key) ? value[key] : persisted[key]);
    const status = object(value.status);
    const knownStatus = ["active", "idle", "notLoaded", "systemError"].includes(String(status.type));
    const loaded = knownStatus ? status.type !== "notLoaded" : null;
    const nativeConfiguration = Object.hasOwn(value, "model") || Object.hasOwn(value, "reasoningEffort");
    const timestamp = (v: unknown): string | null => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 8.64e12 ? new Date(v * 1000).toISOString() : null;
    const source = typeof value.source === "string" ? value.source : Object.keys(spawnSource(value.source)).length ? "subAgentThreadSpawn" : persisted.source;
    const row: ChatTreeRow = {
      botId: bot.id, threadId: id, parentThreadId: id === bot.mainThreadId ? null : node.parent!, depth: visited.size,
      name: field("name"), preview: bounded(value.preview ?? node.historical?.title) ?? "",
      agentNickname: field("agentNickname"), agentRole: field("agentRole"), agentPath: bounded(spawnSource(value.source).agent_path ?? persisted.agentPath),
      model: field("model"), reasoningEffort: field("reasoningEffort"), modelProvider: field("modelProvider"),
      configurationSource: nativeConfiguration ? loaded === true ? "nativeLoaded" : "nativePersisted" : persisted.model ? "rollout" : "unknown",
      configurationAt: nativeConfiguration ? null : bounded(persisted.configurationAt),
      status: { type: knownStatus ? status.type as ChatTreeRow["status"]["type"] : "unknown", activeFlags: Array.isArray(status.activeFlags) ? status.activeFlags.filter((v): v is string => typeof v === "string").slice(0, 16).map((v) => v.slice(0, 128)) : [], freshness: knownStatus ? "live" : "unknown" },
      loaded, cwd: bounded(value.cwd ?? node.historical?.cwd), createdAt: timestamp(value.createdAt) ?? bounded(node.historical?.createdAt), updatedAt: timestamp(value.updatedAt) ?? bounded(node.historical?.updatedAt),
      sessionId: field("sessionId"), forkedFromId: field("forkedFromId"), source: bounded(source), threadSource: field("threadSource"),
      originator: field("originator"), cliVersion: field("cliVersion"), historyMode: field("historyMode"), ephemeral: typeof value.ephemeral === "boolean" ? value.ephemeral : null,
      archived: node.archived ?? null, projectId: field("projectId"), sources: [...(node.historical ? ["rollout" as const] : []), ...(node.native ? ["native" as const] : [])], metadataTruncated,
    };
    rows.push(row);
    if (node.native) native.set(id, node.native);
  }
  rows.sort((a, b) => a.depth - b.depth || a.threadId.localeCompare(b.threadId));
  coverage.issues = [...new Set(coverage.issues)].sort();
  const snapshot = createHash("sha256").update(JSON.stringify({ root: bot.mainThreadId, rows, coverage })).digest("hex");
  return { rootThreadId: bot.mainThreadId, rows, snapshot, observedAt: new Date().toISOString(), coverage, native };
}

export function pageChatTree(tree: TreeSnapshot, offset: number, limit: number, expectedSnapshot?: string): z.infer<typeof chatTreePage> {
  if (expectedSnapshot && expectedSnapshot !== tree.snapshot) throw new Error("chat tree changed; restart paging at offset 0");
  const rows: ChatTreeRow[] = [];
  let bytes = 0;
  for (const row of tree.rows.slice(offset, offset + limit)) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 250_000 && rows.length) break;
    rows.push(row);
  }
  return { rootThreadId: tree.rootThreadId, rows, total: tree.rows.length, nextOffset: offset + rows.length < tree.rows.length ? offset + rows.length : null, snapshot: tree.snapshot, observedAt: tree.observedAt, coverage: tree.coverage };
}

type Evidence = { source: "rollout" | "nativeItems"; threadId: string; line?: number; itemId?: string; value: unknown };

/** A raw evidence document. No inferred spawn arguments or first inherited user prompt. */
export async function chatTreeDetail(index: ChatIndex, bot: ServerView, tree: TreeSnapshot, threadId: string, rpc?: Rpc): Promise<RecordValue> {
  const row = tree.rows.find((item) => item.threadId === threadId);
  if (!row) throw new Error("thread is not in this Bot's main-thread lineage");
  const issues: string[] = [];
  let sessionMeta: Evidence | null = null;
  let initialContext: Evidence | null = null;
  let startingInput: Evidence | null = null;
  let spawn: Evidence | null = null;
  let spawnArguments: Evidence | null = null;
  let ownStart: number | null = row.parentThreadId ? null : 0;
  try {
    for await (const { line, record } of index.treeRecords(bot.id, threadId)) {
      const payload = object(record.payload);
      const evidence: Evidence = { source: "rollout", threadId, line, value: payload };
      if (record.type === "session_meta") {
        sessionMeta = evidence;
        if (typeof payload.subagent_history_start_ordinal === "number") ownStart = payload.subagent_history_start_ordinal;
        // Without inherited/forked history, the local first user message is the starting input.
        else if (!payload.history_base && !payload.forked_from_id) ownStart = 0;
        else { ownStart = null; issues.push("inherited_history_boundary_unknown"); }
        const prefixEnd = object(payload.history_base).end_ordinal_exclusive;
        if (typeof prefixEnd === "number" && ownStart !== null && prefixEnd > ownStart) {
          ownStart = null; issues.push("starting_input_in_history_base");
        }
      }
      // Paginated ordinals are explicit and may start after a history_base prefix.
      if (ownStart === null || ownStart > 0 && (typeof record.ordinal !== "number" || record.ordinal < ownStart)) continue;
      if (!initialContext && record.type === "turn_context") initialContext = evidence;
      if (!startingInput && record.type === "response_item" && payload.type === "message" && payload.role === "user") {
        const body = Array.isArray(payload.content) ? payload.content.map((part) => string(object(part).text) ?? "").join("\n") : "";
        if (!["<environment_context>", "<recommended_plugins>", "<user_instructions>", "# AGENTS.md"].some((prefix) => body.startsWith(prefix))) startingInput = evidence;
      }
      if (sessionMeta && initialContext && startingInput) break;
    }
    if (row.parentThreadId) {
      let callId: string | null = null;
      for await (const { line, record } of index.treeRecords(bot.id, row.parentThreadId)) {
        const payload = object(record.payload);
        if (record.type === "event_msg" && payload.type === "collab_agent_spawn_end" && payload.new_thread_id === threadId && payload.sender_thread_id === row.parentThreadId) {
          spawn = { source: "rollout", threadId: row.parentThreadId, line, value: payload };
          callId = string(payload.call_id); break;
        }
        if (record.type === "response_item" && payload.type === "function_call_output" && typeof payload.output === "string") {
          let result: RecordValue;
          try { result = object(JSON.parse(payload.output)); } catch { continue; }
          if (result.agent_id === threadId) callId = string(payload.call_id);
        }
      }
      if (callId) for await (const { line, record } of index.treeRecords(bot.id, row.parentThreadId)) {
        const payload = object(record.payload);
        if (record.type === "response_item" && payload.type === "function_call" && payload.call_id === callId && payload.name === "spawn_agent") {
          spawnArguments = { source: "rollout", threadId: row.parentThreadId, line, value: payload }; break;
        }
      }
    }
  } catch { issues.push("rollout_detail_read_failed"); }
  // Native projection knows which child records are inherited. Bound its scan and report gaps.
  if (bot.state === "running" && bot.url && !bot.recoveryIssue && bot.runningAccount && (!startingInput || row.parentThreadId && !spawn)) {
    const collect = async (call: Rpc) => {
      for (const target of [...new Set([!startingInput ? threadId : null, !spawn ? row.parentThreadId : null].filter((id): id is string => !!id))]) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < 20; page++) {
          const response = object(await call("thread/items/list", { threadId: target, cursor, limit: 50, sortDirection: "asc" }));
          if (!Array.isArray(response.data)) throw new Error("invalid items");
          for (const entry of response.data) {
            // ThreadItemsListResponse carries {turnId,item}, not bare items.
            const item = object(object(entry).item);
            const evidence: Evidence = { source: "nativeItems", threadId: target, itemId: string(item.id) ?? undefined, value: item };
            if (!startingInput && target === threadId && item.type === "userMessage") startingInput = evidence;
            if (!spawn && target === row.parentThreadId && item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.includes(threadId)) spawn = evidence;
          }
          if (target === threadId ? !!startingInput : !!spawn) break;
          cursor = string(response.nextCursor);
          if (!cursor) break;
          if (page === 19 || seen.has(cursor)) { issues.push("native_items_limit"); break; }
          seen.add(cursor);
        }
      }
    };
    try { if (rpc) await collect(rpc); else await withAppServer(bot.url, collect); }
    catch { issues.push("native_detail_read_failed"); }
  }
  if (!startingInput) issues.push("starting_input_unavailable");
  if (row.parentThreadId && !spawnArguments) issues.push("spawn_arguments_unavailable");
  return { thread: row, nativeThread: tree.native.get(threadId) ?? null, sessionMeta, initialContext, startingInput, spawn, spawnArguments,
    coverage: { ...tree.coverage, detail: "bestEffort", issues: [...new Set([...tree.coverage.issues, ...issues])] } };
}

export function detailChunk(value: RecordValue, offset: number, length: number, expectedRevision?: string) {
  const json = JSON.stringify(value);
  const revision = createHash("sha256").update(json).digest("hex");
  if (expectedRevision && expectedRevision !== revision) throw new Error("chat detail changed; restart reading at offset 0");
  if (offset > json.length) throw new Error("offset exceeds detail length");
  const end = Math.min(json.length, offset + length);
  return { text: json.slice(offset, end), totalChars: json.length, nextOffset: end < json.length ? end : null, revision, observedAt: new Date().toISOString() };
}
