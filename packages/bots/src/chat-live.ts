import { randomUUID } from "node:crypto";

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw => value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const itemLimit = 48_000;
const snapshotLimit = 320_000;

export type LiveItem = { turnId: string; item: Raw; complete: boolean; completed: boolean; omitted: boolean };
type Projection = { url: string; threadId: string; instance: string; revision: number; activeTurnId: string | null; items: Map<string, LiveItem> };

/** A bounded, partial observation of the current root; native history remains authoritative. */
export class LiveChats {
  private readonly bots = new Map<string, Projection>();

  private ensure(botId: string, url: string, threadId: string): Projection {
    let row = this.bots.get(botId);
    if (!row || row.url !== url || row.threadId !== threadId) {
      row = { url, threadId, instance: randomUUID(), revision: 0, activeTurnId: null, items: new Map() };
      this.bots.set(botId, row);
    }
    return row;
  }

  connected(botId: string, url: string): void {
    const row = this.bots.get(botId);
    if (row?.url === url) this.bots.delete(botId); // A reconnect cannot replay missed deltas.
  }

  remove(botId: string): void { this.bots.delete(botId); }

  read(botId: string, url: string | null, threadId: string | null) {
    if (!url || !threadId) {
      this.remove(botId);
      return { threadId, instance: null, revision: 0, activeTurnId: null, coverage: "partial" as const, items: [] as LiveItem[] };
    }
    const row = this.ensure(botId, url, threadId);
    return { threadId, instance: row.instance, revision: row.revision, activeTurnId: row.activeTurnId,
      coverage: "partial" as const, items: [...row.items.values()] };
  }

  observe(botId: string, url: string, threadId: string | null, method: string, params: unknown): void {
    if (!threadId) return;
    const data = object(params);
    if (data.threadId !== threadId) return; // Other roots and descendants are not this transcript.
    const row = this.ensure(botId, url, threadId);
    if (method === "thread/reverted" || method === "thread/deleted") {
      row.items.clear(); row.activeTurnId = null; row.revision++;
      return;
    }
    if (method === "turn/started") {
      row.activeTurnId = text(object(data.turn).id) || null;
      row.revision++;
      return;
    }
    if (method === "turn/completed") {
      row.activeTurnId = null;
      row.revision++;
      return;
    }
    const turnId = text(data.turnId);
    const source = object(data.item);
    const itemId = text(source.id) || text(data.itemId);
    if (!turnId || !itemId) return;
    const key = JSON.stringify([turnId, itemId]);
    if (method === "item/started" || method === "item/completed") {
      const omitted = JSON.stringify(source).length > itemLimit;
      row.items.delete(key);
      row.items.set(key, { turnId, item: omitted ? summary(source, itemId) : source,
        complete: !omitted, completed: method === "item/completed", omitted });
    } else {
      const previous = row.items.get(key);
      if (!previous || previous.completed || previous.omitted) return;
      const field = method === "item/agentMessage/delta" || method === "item/plan/delta" ? "text"
        : method === "item/commandExecution/outputDelta" ? "aggregatedOutput" : null;
      if (!field || typeof data.delta !== "string") {
        // Do not claim a complete live item when an unprojected native delta arrived.
        row.items.set(key, { ...previous, complete: false });
        row.revision++;
        return;
      }
      const item = { ...previous.item, [field]: text(previous.item[field]) + data.delta };
      const omitted = JSON.stringify(item).length > itemLimit;
      row.items.set(key, omitted
        ? { ...previous, item: summary(item, itemId), complete: false, omitted: true }
        : { ...previous, item });
    }
    row.revision++;
    while (row.items.size > 64 || JSON.stringify([...row.items.values()]).length > snapshotLimit) {
      row.items.delete(row.items.keys().next().value!);
    }
  }
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
