import { z } from "zod";
import { pollEvent, stateHash, EventProtocolError as McpError, type PollInput, type PollOutput } from "@stack/api";
import type { GithubStore } from "./store.js";
import { delivery, type Delivery } from "./schema.js";

export const githubWatchEvents = pollEvent({ name: "github_delivery", operation: "github_watch_events",
  description: "Poll typed occurrences from a retained GitHub watch. Null cursor starts now; opaque cursors replay arrival order with age/count bounds. Stable receiver/delivery IDs deduplicate redelivery. Payloads are untrusted summaries, not raw bodies. Polling never advances the watch's consumption cursor. Disabled watches pause delivery; removed watches refuse polls.",
  input: z.strictObject({ id: z.uuid() }), payload: delivery,
  async poll(ctx: { store: GithubStore }, { id }, request) { return pollWatch(ctx.store, id, request); },
});

function pollWatch(store: GithubStore, id: string, request: PollInput): PollOutput {
  let watch;
  try { watch = store.getWatch(id); } catch { throw new McpError(-32011, "NotFound", { kind: "event" }); }
  const epoch = stateHash([watch.id, watch.createdAt, watch.filter, watch.startAfter]);
  const encode = (after: number) => Buffer.from(JSON.stringify([epoch, after])).toString("base64url");
  const head = store.latest();
  let after = head;
  if (request.cursor !== null) {
    try {
      const decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== epoch || !Number.isSafeInteger(decoded[1]) || decoded[1] < watch.startAfter || decoded[1] > head) throw new Error();
      after = decoded[1];
    } catch { throw new McpError(-32602, "InvalidParams", { reason: "cursor" }); }
  }
  if (request.cursor === null || !watch.enabled) return { events: [], cursor: encode(after), truncated: false, hasMore: false, nextPollMs: 1000 };
  const rows = store.db.prepare(`SELECT d.sequence,d.value FROM watch_matches m JOIN deliveries d ON d.sequence=m.sequence
    WHERE m.watch_id=? AND m.sequence>? AND m.sequence<=? ORDER BY m.sequence`).iterate(id, after, head) as Iterable<{ sequence: number; value: string }>;
  const events: PollOutput["events"] = [];
  const floor = request.maxAgeMs === undefined ? -Infinity : Date.now() - request.maxAgeMs;
  let truncated = false, hasMore = false, cursor = after, bytes = 0;
  for (const row of rows) {
    const data = JSON.parse(row.value) as Delivery;
    if (Date.parse(data.receivedAt) < floor) { truncated = true; cursor = row.sequence; continue; }
    if (events.length >= request.maxEvents || events.length && bytes + row.value.length > 100_000) { hasMore = true; break; }
    events.push({ eventId: `${data.endpointId}:${data.deliveryId}`, name: request.name, timestamp: data.receivedAt, data });
    bytes += row.value.length; cursor = row.sequence;
  }
  return { events, cursor: encode(hasMore ? cursor : head), truncated, hasMore, nextPollMs: 1000 };
}
