import { randomUUID } from "node:crypto";

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw => value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const itemLimit = 48_000;
const snapshotLimit = 320_000;

export type LiveItem = { turnId: string; item: Raw; complete: boolean; completed: boolean; omitted: boolean };
/** Each row records the revision that last changed it, so a follower can read only newer rows. */
type Row = LiveItem & { revision: number };
type Projection = { url: string; threadId: string; instance: string; revision: number; activeTurnId: string | null; activeTurnStartedAt: number | null;
  /** The latest revision that discarded rows; a follower behind it must replace its copy. */
  cleared: number; items: Map<string, Row> };
/** A follower's last applied read: same instance and revision returns only rows changed since. */
export type LiveCursor = { instance: string; revision: number };

/** A bounded, partial observation of the current root; native history remains authoritative. */
export class LiveChats {
  private readonly bots = new Map<string, Projection>();

  private ensure(botId: string, url: string, threadId: string): Projection {
    let row = this.bots.get(botId);
    if (!row || row.url !== url || row.threadId !== threadId) {
      row = { url, threadId, instance: randomUUID(), revision: 0, activeTurnId: null, activeTurnStartedAt: null, cleared: 0, items: new Map() };
      this.bots.set(botId, row);
    }
    return row;
  }

  connected(botId: string, url: string): void {
    const row = this.bots.get(botId);
    if (row?.url === url) this.bots.delete(botId); // A reconnect cannot replay missed deltas.
  }

  remove(botId: string): void { this.bots.delete(botId); }

  /** Rows changed after `after` when it names this instance and no rows were discarded since; otherwise the full snapshot with reset. */
  read(botId: string, url: string | null, threadId: string | null, after?: LiveCursor) {
    if (!url || !threadId) {
      this.remove(botId);
      return { threadId, instance: null, revision: 0, activeTurnId: null, activeTurnStartedAt: null, coverage: "partial" as const, reset: true, items: [] as LiveItem[] };
    }
    const row = this.ensure(botId, url, threadId);
    const incremental = after !== undefined && after.instance === row.instance && after.revision >= row.cleared && after.revision <= row.revision;
    const items = [...row.items.values()].flatMap(({ revision, ...item }) => !incremental || revision > after.revision ? [item] : []);
    return { threadId, instance: row.instance, revision: row.revision, activeTurnId: row.activeTurnId, activeTurnStartedAt: row.activeTurnStartedAt,
      coverage: "partial" as const, reset: !incremental, items };
  }

  /** The current revision, for callers that publish only real projection changes. */
  revision(botId: string): number | null { return this.bots.get(botId)?.revision ?? null; }

  observe(botId: string, url: string, threadId: string | null, method: string, params: unknown): void {
    if (!threadId) return;
    const data = object(params);
    if (data.threadId !== threadId) return; // Other roots and descendants are not this transcript.
    const row = this.ensure(botId, url, threadId);
    if (method === "thread/reverted" || method === "thread/deleted") {
      row.items.clear(); row.activeTurnId = null; row.activeTurnStartedAt = null; row.cleared = ++row.revision;
      return;
    }
    if (method === "turn/started") {
      const turn = object(data.turn);
      row.activeTurnId = text(turn.id) || null;
      // Native startedAt is in seconds; an observation time is the honest fallback.
      row.activeTurnStartedAt = typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt) ? turn.startedAt * 1000 : Date.now();
      row.revision++;
      return;
    }
    if (method === "turn/completed") {
      row.activeTurnId = null;
      row.activeTurnStartedAt = null;
      row.revision++;
      return;
    }
    const turnId = text(data.turnId);
    const source = object(data.item);
    const itemId = text(source.id) || text(data.itemId);
    if (!turnId || !itemId) return;
    const key = JSON.stringify([turnId, itemId]);
    const revision = row.revision + 1;
    if (method === "item/started" || method === "item/completed") {
      const omitted = JSON.stringify(source).length > itemLimit;
      // A completion keeps the item's place: rows stay in native start order.
      row.items.set(key, { turnId, item: omitted ? summary(source, itemId) : source,
        complete: !omitted, completed: method === "item/completed", omitted, revision });
    } else {
      const previous = row.items.get(key);
      if (!previous || previous.completed || previous.omitted) return;
      const item = project(previous.item, method, data);
      if (!item) {
        // Do not claim a complete live item when an unprojected native delta arrived.
        row.items.set(key, { ...previous, complete: false, revision });
        row.revision = revision;
        return;
      }
      const omitted = JSON.stringify(item).length > itemLimit;
      row.items.set(key, omitted
        ? { ...previous, item: summary(item, itemId), complete: false, omitted: true, revision }
        : { ...previous, item, revision });
    }
    row.revision = revision;
    while (row.items.size > 64 || JSON.stringify([...row.items.values()]).length > snapshotLimit) {
      row.items.delete(row.items.keys().next().value!);
    }
  }
}

/** Project one streamed native change onto its item field, or null when it has no projection. */
function project(item: Raw, method: string, data: Raw): Raw | null {
  const delta = typeof data.delta === "string" ? data.delta : null;
  if (method === "item/reasoning/summaryPartAdded") return parts(item, "summary", data.summaryIndex, "");
  if (delta === null) return null;
  if (method === "item/agentMessage/delta" || method === "item/plan/delta") return { ...item, text: text(item.text) + delta };
  if (method === "item/commandExecution/outputDelta") return { ...item, aggregatedOutput: text(item.aggregatedOutput) + delta };
  if (method === "item/reasoning/summaryTextDelta") return parts(item, "summary", data.summaryIndex, delta);
  if (method === "item/reasoning/textDelta") return parts(item, "content", data.contentIndex, delta);
  return null;
}

/** Append to one indexed reasoning part, creating the parts before it. */
function parts(item: Raw, field: "summary" | "content", index: unknown, delta: string): Raw | null {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 256) return null;
  const values = Array.isArray(item[field]) ? (item[field] as unknown[]).map(text) : [];
  while (values.length <= index) values.push("");
  values[index] += delta;
  return { ...item, [field]: values };
}

function summary(item: Raw, id: string): Raw {
  return { id, type: text(item.type) || "unknown", ...Object.fromEntries(
    ["status", "name", "command", "exitCode"].flatMap((key) => {
      const value = item[key];
      return (typeof value === "string" && value.length <= 200 || typeof value === "number" && Number.isFinite(value)) ? [[key, value]] : [];
    }),
  ) };
}

/** Page native items newest first without letting a long tool output break the socket response budget. */
export async function boundedMainItems(
  call: (limit: number) => Promise<Raw>, limit: number,
): Promise<{ data: Raw[]; nextCursor: string | null }> {
  let size = limit;
  while (true) {
    const result = callResult(await call(size));
    if (result.data.length > size) throw new Error("thread/items/list exceeded the requested page size");
    if (JSON.stringify(result).length <= 500_000) return result;
    if (size === 1) {
      if (result.data.length !== 1) throw new Error("thread/items/list returned an oversized empty page");
      const entry = object(result.data[0]);
      const item = object(entry.item);
      return { data: [{ turnId: text(entry.turnId), item: summary(item, text(item.id)), omitted: true }], nextCursor: result.nextCursor };
    }
    size = Math.max(1, Math.floor(size / 2));
  }
}

function callResult(result: Raw): { data: Raw[]; nextCursor: string | null } {
  if (!Array.isArray(result.data) || !result.data.every((item: unknown) => item && typeof item === "object" && !Array.isArray(item))
    || !(result.nextCursor === null || typeof result.nextCursor === "string" && result.nextCursor.length <= 8192)
    || result.data.length === 0 && result.nextCursor !== null) throw new Error("thread/items/list returned invalid data");
  return { data: result.data as Raw[], nextCursor: result.nextCursor };
}
