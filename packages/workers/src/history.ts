import type { DatabaseSync } from "node:sqlite";
import { record } from "./acp.js";
import { currentOption, effortOption, modelOption, optionsOf } from "./catalog.js";

export type RecordSource = "live" | "replay" | "response" | "submitted";
export type StructuredRecord = { seq: number; workerId: string; turnId: string | null; kind: string;
  source: RecordSource; at: number; data: Record<string, unknown> | null; dataChars: number; oversized: boolean };
export type ObservedSettings = { model: string | null; effort: string | null; mode: string | null; at: number; recordSeq: number };
export type ToolRecord = { toolCallId: string; turnId: string | null; firstSeq: number; lastSeq: number;
  title: string | null; kind: string | null; status: string | null; record: StructuredRecord };
export type TaskObservation = { toolCallId: string; sessionId: string; callingSessionId: string;
  toolStatus: string | null; background: boolean; model: { providerID: string | null; modelID: string | null } | null; recordSeq: number;
  visibility: "task_reference"; hierarchyVerified: false; childStatus: "unknown" };

const MAX_RECORDS = 20_000;
const MAX_CHARS = 32_000_000;
const INLINE_CHARS = 8_000;
const PAGE_BYTES = 200_000;
const metadataKinds = new Set(["runtime", "launch", "config_option_update", "current_mode_update", "session_info_update",
  "usage_update", "available_commands_update", "plan", "session/new", "session/load"]);
const updateKinds = new Set(["agent_message_chunk", "user_message_chunk", "tool_call", "tool_call_update", "plan",
  "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update"]);

/** Retain vendor JSON, but never reasoning blocks or known credential fields. Launch metadata is separately allowlisted. */
export function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return "[depth limit]";
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s"<>]*\/mcp\/[^\s"<>]*[?][^\s"<>]*/g, "[private MCP URL]");
  if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
  if (!record(value)) return value;
  if (["reasoning", "thinking", "agent_thought_chunk"].includes(String(value.type ?? value.sessionUpdate))) return { omitted: "raw reasoning" };
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["__proto__", "constructor", "prototype"].includes(key)).map(([key, item]) =>
    [key, /^(authorization|credentials?|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|reasoning|thinking|chain_of_thought)$/i.test(key)
      ? "[omitted]" : safeValue(item, depth + 1)]));
}

function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function identifier(value: unknown): string | null { return typeof value === "string" && value.length <= 512 ? value : null; }

/** Immutable observations plus bounded latest projections. ACP supplies no turn IDs; replay is never assigned to a turn. */
export class WorkerHistory {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL REFERENCES workers(id),
        turn_id TEXT REFERENCES turns(id), kind TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worker_records_page ON worker_records(worker_id, seq);
      CREATE TABLE IF NOT EXISTS worker_capture (
        worker_id TEXT PRIMARY KEY REFERENCES workers(id), records INTEGER NOT NULL DEFAULT 0,
        chars INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, last_observed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS worker_metadata (
        worker_id TEXT NOT NULL REFERENCES workers(id), kind TEXT NOT NULL, seq INTEGER NOT NULL REFERENCES worker_records(seq),
        PRIMARY KEY(worker_id, kind)
      );
      CREATE TABLE IF NOT EXISTS worker_tools (
        worker_id TEXT NOT NULL REFERENCES workers(id), tool_call_id TEXT NOT NULL, turn_id TEXT REFERENCES turns(id),
        first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL REFERENCES worker_records(seq),
        PRIMARY KEY(worker_id, tool_call_id)
      );
    `);
  }

  capture(workerId: string) {
    const row = this.db.prepare("SELECT records, chars, dropped, last_observed_at FROM worker_capture WHERE worker_id = ?").get(workerId) as
      { records: number; chars: number; dropped: number; last_observed_at: number | null } | undefined;
    return { records: row?.records ?? 0, retainedChars: row?.chars ?? 0, droppedRecords: row?.dropped ?? 0,
      lastObservedAt: row?.last_observed_at ?? null, maxRecords: MAX_RECORDS, maxChars: MAX_CHARS,
      truncated: Boolean(row?.dropped) };
  }

  drop(workerId: string, count = 1): void {
    this.db.prepare(`INSERT INTO worker_capture (worker_id, dropped, last_observed_at) VALUES (?,?,?)
      ON CONFLICT(worker_id) DO UPDATE SET dropped = dropped + excluded.dropped, last_observed_at = excluded.last_observed_at`)
      .run(workerId, count, Date.now());
  }

  private atomic<T>(write: () => T): T {
    // SAVEPOINT also composes with admission's existing transaction.
    this.db.exec("SAVEPOINT worker_history");
    try { const value = write(); this.db.exec("RELEASE worker_history"); return value; }
    catch (error) { this.db.exec("ROLLBACK TO worker_history; RELEASE worker_history"); throw error; }
  }

  append(workerId: string, turnId: string | null, kind: string, source: RecordSource, data: Record<string, unknown>): number | null {
    return this.atomic(() => this.insert(workerId, turnId, kind, source, data));
  }
  private insert(workerId: string, turnId: string | null, kind: string, source: RecordSource, data: Record<string, unknown>): number | null {
    const json = JSON.stringify(safeValue(data));
    const capture = this.capture(workerId);
    if (capture.records >= MAX_RECORDS || capture.retainedChars + json.length > MAX_CHARS) { this.drop(workerId); return null; }
    const at = Date.now();
    const seq = Number(this.db.prepare("INSERT INTO worker_records (worker_id, turn_id, kind, source, at, data_json) VALUES (?,?,?,?,?,?)")
      .run(workerId, turnId, kind, source, at, json).lastInsertRowid);
    this.db.prepare(`INSERT INTO worker_capture (worker_id, records, chars, last_observed_at) VALUES (?,1,?,?)
      ON CONFLICT(worker_id) DO UPDATE SET records = records + 1, chars = chars + excluded.chars, last_observed_at = excluded.last_observed_at`)
      .run(workerId, json.length, at);
    if (metadataKinds.has(kind)) this.db.prepare(`INSERT INTO worker_metadata (worker_id, kind, seq) VALUES (?,?,?)
      ON CONFLICT(worker_id, kind) DO UPDATE SET seq = excluded.seq`).run(workerId, kind, seq);
    return seq;
  }

  update(workerId: string, turnId: string | null, source: "live" | "replay", update: Record<string, unknown>, meta?: unknown): number | null {
    return this.atomic(() => this.applyUpdate(workerId, turnId, source, update, meta));
  }
  private applyUpdate(workerId: string, turnId: string | null, source: "live" | "replay", update: Record<string, unknown>, meta?: unknown): number | null {
    const kind = update.sessionUpdate;
    if (typeof kind !== "string" || !updateKinds.has(kind)) return null;
    const safe = safeValue(update) as Record<string, unknown>;
    const toolId = typeof safe.toolCallId === "string" && safe.toolCallId.length <= 512 ? safe.toolCallId : null;
    let previous: { turn_id: string | null; first_seq: number; last_seq: number } | undefined;
    let toolCall: Record<string, unknown> | undefined;
    if ((kind === "tool_call" || kind === "tool_call_update") && toolId) {
      previous = this.db.prepare("SELECT turn_id, first_seq, last_seq FROM worker_tools WHERE worker_id = ? AND tool_call_id = ?")
        .get(workerId, toolId) as typeof previous;
      const prior = previous ? this.data(workerId, previous.last_seq).toolCall : undefined;
      // ACP updates replace supplied fields (including arrays); absent fields retain their last value.
      toolCall = { ...(record(prior) ? prior : {}), ...safe };
    }
    let sessionInfo: Record<string, unknown> | undefined;
    if (kind === "session_info_update") {
      const prior = this.db.prepare("SELECT seq FROM worker_metadata WHERE worker_id = ? AND kind = ?").get(workerId, kind) as { seq: number } | undefined;
      const data = prior ? this.data(workerId, prior.seq) : {};
      sessionInfo = { ...(record(data.sessionInfo) ? data.sessionInfo : {}), ...safe };
    }
    const attributedTurn = source === "replay" ? null : previous ? previous.turn_id : turnId;
    const seq = this.insert(workerId, attributedTurn, kind, source, { update: safe, ...(meta === undefined ? {} : { _meta: meta }),
      ...(toolCall ? { toolCall } : {}), ...(sessionInfo ? { sessionInfo } : {}) });
    if (seq !== null && toolCall && toolId) this.db.prepare(`INSERT INTO worker_tools (worker_id, tool_call_id, turn_id, first_seq, last_seq) VALUES (?,?,?,?,?)
      ON CONFLICT(worker_id, tool_call_id) DO UPDATE SET last_seq = excluded.last_seq`)
      .run(workerId, toolId, previous ? previous.turn_id : turnId, previous?.first_seq ?? seq, seq);
    return seq;
  }

  private row(workerId: string, seq: number) {
    return this.db.prepare("SELECT * FROM worker_records WHERE worker_id = ? AND seq = ?").get(workerId, seq) as
      { seq: number; worker_id: string; turn_id: string | null; kind: string; source: RecordSource; at: number; data_json: string } | undefined;
  }
  data(workerId: string, seq: number): Record<string, unknown> {
    const row = this.row(workerId, seq);
    if (!row) throw new Error("unknown worker record");
    return JSON.parse(row.data_json) as Record<string, unknown>;
  }
  toolTurnId(workerId: string, toolCallId: string): string | null | undefined {
    const row = this.db.prepare("SELECT turn_id FROM worker_tools WHERE worker_id = ? AND tool_call_id = ?")
      .get(workerId, toolCallId) as { turn_id: string | null } | undefined;
    // An observed but unattributed tool must remain null, distinct from an unseen tool.
    return row?.turn_id;
  }
  get(workerId: string, seq: number): StructuredRecord {
    const row = this.row(workerId, seq);
    if (!row) throw new Error("unknown worker record");
    return { seq, workerId, turnId: row.turn_id, kind: row.kind, source: row.source, at: row.at,
      data: row.data_json.length <= INLINE_CHARS ? JSON.parse(row.data_json) as Record<string, unknown> : null,
      dataChars: row.data_json.length, oversized: row.data_json.length > INLINE_CHARS };
  }
  chunk(workerId: string, seq: number, offset: number, limit: number) {
    const row = this.row(workerId, seq);
    if (!row) throw new Error("unknown worker record");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.data_json.length) throw new Error("record offset is out of range");
    const data = row.data_json.slice(offset, offset + Math.max(1, Math.min(limit, 16_000)));
    return { seq, offset, data, nextOffset: offset + data.length, totalChars: row.data_json.length,
      hasMore: offset + data.length < row.data_json.length, encoding: "json-utf16" as const };
  }
  read(workerId: string, afterSeq: number, limit: number, turnId?: string) {
    const rows = this.db.prepare(`SELECT seq FROM worker_records WHERE worker_id = ? AND seq > ? ${turnId ? "AND turn_id = ?" : ""} ORDER BY seq LIMIT ?`)
      .all(...(turnId ? [workerId, afterSeq, turnId, Math.min(limit, 50) + 1] : [workerId, afterSeq, Math.min(limit, 50) + 1])) as Array<{ seq: number }>;
    const entries: StructuredRecord[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const entry = this.get(workerId, row.seq);
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length && bytes + size > PAGE_BYTES) break;
      bytes += size; entries.push(entry);
    }
    return { entries, nextSeq: entries.at(-1)?.seq ?? afterSeq, hasMore: rows.length > entries.length, capture: this.capture(workerId) };
  }
  metadata(workerId: string): StructuredRecord[] {
    return (this.db.prepare("SELECT seq FROM worker_metadata WHERE worker_id = ? ORDER BY seq").all(workerId) as Array<{ seq: number }>)
      .map(({ seq }) => this.get(workerId, seq));
  }
  settings(workerId: string): ObservedSettings | null {
    const observed: ObservedSettings = { model: null, effort: null, mode: null, at: 0, recordSeq: 0 };
    let found = false;
    for (const reference of this.metadata(workerId)) {
      if (!["session/new", "session/load", "config_option_update", "current_mode_update"].includes(reference.kind)) continue;
      const value = this.data(workerId, reference.seq);
      const data = record(value.update) ? value.update : value;
      const options = optionsOf(data);
      const model = modelOption(options);
      const effort = effortOption(options);
      const mode = options.find((option) => option.category === "mode");
      const models = record(data.models) ? data.models : {};
      const modes = record(data.modes) ? data.modes : {};
      observed.model = identifier(model ? currentOption(data, model.id) : models.currentModelId) ?? observed.model;
      observed.effort = options.length ? identifier(effort ? currentOption(data, effort.id) : null) : observed.effort;
      observed.mode = identifier(mode ? currentOption(data, mode.id) : data.currentModeId ?? modes.currentModeId) ?? observed.mode;
      observed.at = reference.at; observed.recordSeq = reference.seq; found = true;
    }
    return found ? observed : null;
  }
  tools(workerId: string, afterSeq: number, limit: number) {
    const rows = this.db.prepare("SELECT * FROM worker_tools WHERE worker_id = ? AND first_seq > ? ORDER BY first_seq LIMIT ?")
      .all(workerId, afterSeq, Math.min(limit, 50) + 1) as Array<{ tool_call_id: string; turn_id: string | null; first_seq: number; last_seq: number }>;
    const tools: ToolRecord[] = [];
    const tasks: TaskObservation[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const data = this.data(workerId, row.last_seq).toolCall;
      if (!record(data)) continue;
      const tool: ToolRecord = { toolCallId: row.tool_call_id, turnId: row.turn_id, firstSeq: row.first_seq, lastSeq: row.last_seq,
        title: text(data.title)?.slice(0, 2_000) ?? null, kind: identifier(data.kind), status: identifier(data.status), record: this.get(workerId, row.last_seq) };
      const size = Buffer.byteLength(JSON.stringify(tool));
      if (tools.length && bytes + size > PAGE_BYTES) break;
      bytes += size; tools.push(tool);
      const worker = this.db.prepare("SELECT provider, acp_session_id FROM workers WHERE id = ?").get(workerId) as { provider: string; acp_session_id: string | null };
      const input = record(data.rawInput) ? data.rawInput : {};
      const output = record(data.rawOutput) ? data.rawOutput : {};
      const meta = record(output.metadata) ? output.metadata : {};
      // OpenCode task.ts -> acp/tool.ts. This is an invocation reference, NOT an ACP parent/child declaration.
      if (["codex", "grok"].includes(worker.provider) && data.kind === "think" && typeof input.subagent_type === "string"
        && typeof input.prompt === "string" && typeof meta.sessionId === "string" && meta.sessionId.length <= 512 && typeof meta.parentSessionId === "string"
        && meta.parentSessionId === worker.acp_session_id) {
        tasks.push({ toolCallId: row.tool_call_id, sessionId: meta.sessionId, callingSessionId: meta.parentSessionId,
          toolStatus: tool.status, background: meta.background === true,
          model: record(meta.model) ? { providerID: identifier(meta.model.providerID), modelID: identifier(meta.model.modelID) } : null, recordSeq: row.last_seq,
          visibility: "task_reference", hierarchyVerified: false, childStatus: "unknown" });
      }
    }
    return { tools, tasks, nextSeq: tools.at(-1)?.firstSeq ?? afterSeq, hasMore: rows.length > tools.length };
  }
  remove(workerId: string): void {
    for (const table of ["worker_tools", "worker_metadata", "worker_capture", "worker_records"])
      this.db.prepare(`DELETE FROM ${table} WHERE worker_id = ?`).run(workerId);
  }
}
