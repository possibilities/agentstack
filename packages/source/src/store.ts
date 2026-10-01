import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateJournal, stateHash, type StateApplyInput } from "@stack/api";
import type { z } from "zod";
import { matches } from "./filter.js";
import { decodePayload } from "./payload.js";
import { object, summarize, type DeliveryHeaders } from "./summary.js";
import { endpointCreate, watchCreate, hookPlan, type Delivery, type Endpoint, type Filter, type Watch, type RemoteReceipt } from "./schema.js";

type EndpointRow = { id: string; digest: string; value: string; secret: string; previous_secret: string | null };
type DeliveryRow = { sequence: number; endpoint_id: string; delivery_id: string; digest: string; value: string; raw: Uint8Array | null };
export class GithubStore {
  readonly db: DatabaseSync;
  readonly maintenance: StateJournal;
  readonly maxPayloadBytes: number;
  readonly maxPayloads = 10_000;
  constructor(stateRoot: string, maxPayloadBytes = 512 * 1024 * 1024) {
    this.maxPayloadBytes = maxPayloadBytes;
    const dir = join(stateRoot, "github");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.privateFile(dir, true);
    const path = join(dir, "github.sqlite");
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.privateFile(path, false);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
      const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > 1) throw new Error("github_schema_unsupported");
      if (!version) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE endpoints(id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL, secret TEXT NOT NULL, previous_secret TEXT);
        CREATE TABLE deliveries(sequence INTEGER PRIMARY KEY AUTOINCREMENT, endpoint_id TEXT NOT NULL REFERENCES endpoints(id), delivery_id TEXT NOT NULL,
          digest TEXT NOT NULL, value TEXT NOT NULL, raw BLOB, UNIQUE(endpoint_id,delivery_id));
        CREATE INDEX deliveries_endpoint ON deliveries(endpoint_id,sequence);
        CREATE TABLE watches(id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE watch_matches(watch_id TEXT NOT NULL REFERENCES watches(id), sequence INTEGER NOT NULL REFERENCES deliveries(sequence), PRIMARY KEY(watch_id,sequence));
        CREATE TABLE hook_plans(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE TABLE remote_requests(id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      this.maintenance = new StateJournal(this.db, "source");
      for (const row of this.db.prepare("SELECT id,value FROM remote_requests WHERE json_extract(value,'$.status')='running'").all() as { id: string; value: string }[]) {
        const receipt = JSON.parse(row.value) as RemoteReceipt;
        this.finishRemote({ ...receipt, status: "unknown", completedAt: new Date().toISOString(), error: "owner_interrupted: inspect GitHub before preparing a new request; this request will not execute again" });
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private privateFile(path: string, directory: boolean) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("github_storage_ownership_invalid");
    chmodSync(path, directory ? 0o700 : 0o600);
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  endpointRow(id: string): EndpointRow {
    const row = this.db.prepare("SELECT * FROM endpoints WHERE id=?").get(id) as EndpointRow | undefined;
    if (!row) throw new Error("github_endpoint_not_found"); return row;
  }
  getEndpoint(id: string): Endpoint { return JSON.parse(this.endpointRow(id).value); }
  endpoints(): Endpoint[] { return (this.db.prepare("SELECT value FROM endpoints ORDER BY id").all() as { value: string }[]).map(row => JSON.parse(row.value)); }
  private saveEndpoint(value: Endpoint) { this.db.prepare("UPDATE endpoints SET value=? WHERE id=?").run(JSON.stringify(value), value.id); }
  createEndpoint(input: z.infer<typeof endpointCreate>): Endpoint {
    return this.transaction(() => {
      const digest = stateHash(input);
      const old = this.db.prepare("SELECT * FROM endpoints WHERE id=?").get(input.id) as EndpointRow | undefined;
      if (old) { if (old.digest !== digest) throw new Error("github_endpoint_id_conflict"); return JSON.parse(old.value); }
      if (this.endpoints().length >= 128) throw new Error("github_endpoint_capacity");
      const now = new Date().toISOString(), path = `/github/webhooks/${input.id}`;
      const publicOrigin = input.publicOrigin ? new URL(input.publicOrigin).origin : null;
      const value: Endpoint = { ...input, publicOrigin, path, webhookUrl: publicOrigin ? `${publicOrigin}${path}` : null, enabled: true,
        revision: 1, secretVersion: 1, previousSecretExpiresAt: null, createdAt: now, updatedAt: now, lastDeliveryAt: null, lastPingAt: null,
        accepted: 0, duplicates: 0, rejected: 0, lastFailure: null, managedHookId: null, boundTargetId: null };
      this.db.prepare("INSERT INTO endpoints VALUES(?,?,?,?,NULL)").run(input.id, digest, JSON.stringify(value), randomBytes(32).toString("hex"));
      return value;
    });
  }
  updateEndpoint(id: string, expectedRevision: number, patch: { label?: string; publicOrigin?: string | null; enabled?: boolean }): Endpoint {
    const value = this.getEndpoint(id);
    if (value.revision !== expectedRevision) throw new Error("github_endpoint_revision_changed");
    Object.assign(value, patch, patch.publicOrigin === undefined ? {} : { publicOrigin: patch.publicOrigin ? new URL(patch.publicOrigin).origin : null });
    value.webhookUrl = value.publicOrigin ? `${value.publicOrigin}${value.path}` : null;
    value.revision++; value.updatedAt = new Date().toISOString(); this.saveEndpoint(value); return value;
  }
  rotateSecret(id: string, expectedRevision: number, graceSeconds: number): Endpoint {
    return this.transaction(() => {
      const row = this.endpointRow(id), value = JSON.parse(row.value) as Endpoint;
      if (value.revision !== expectedRevision) throw new Error("github_endpoint_revision_changed");
      value.revision++; value.secretVersion++; value.updatedAt = new Date().toISOString();
      value.previousSecretExpiresAt = graceSeconds ? new Date(Date.now() + graceSeconds * 1000).toISOString() : null;
      this.db.prepare("UPDATE endpoints SET value=?,secret=?,previous_secret=? WHERE id=?")
        .run(JSON.stringify(value), randomBytes(32).toString("hex"), graceSeconds ? row.secret : null, id);
      return value;
    });
  }
  secrets(id: string): string[] {
    const row = this.endpointRow(id), value = JSON.parse(row.value) as Endpoint;
    const previousLive = row.previous_secret && value.previousSecretExpiresAt && Date.parse(value.previousSecretExpiresAt) > Date.now();
    if (row.previous_secret && !previousLive) this.db.prepare("UPDATE endpoints SET previous_secret=NULL WHERE id=?").run(id);
    return previousLive ? [row.secret, row.previous_secret!] : [row.secret];
  }
  failure(id: string, code: string): void {
    const value = this.getEndpoint(id); value.rejected++; value.lastFailure = code; this.saveEndpoint(value);
  }
  payloadUsage() {
    const row = this.db.prepare("SELECT COALESCE(SUM(length(raw)),0) AS bytes,COUNT(raw) AS count FROM deliveries").get() as { bytes: number; count: number };
    return { bytes: row.bytes, count: row.count, maxBytes: this.maxPayloadBytes, maxCount: this.maxPayloads };
  }
  latest(): number { return (this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS value FROM deliveries").get() as { value: number }).value; }
  admit(endpointId: string, headers: DeliveryHeaders, raw: Buffer, payload: Record<string, unknown>) {
    const digest = createHash("sha256").update(JSON.stringify(headers)).update(raw).digest("hex");
    return this.transaction(() => {
      const endpoint = this.getEndpoint(endpointId);
      if (!endpoint.enabled) throw new Error("github_endpoint_disabled");
      const old = this.db.prepare("SELECT * FROM deliveries WHERE endpoint_id=? AND delivery_id=?").get(endpointId, headers.deliveryId) as DeliveryRow | undefined;
      if (old) {
        if (old.digest !== digest) throw new Error("github_delivery_conflict");
        endpoint.duplicates++; this.saveEndpoint(endpoint);
        return { record: JSON.parse(old.value) as Delivery, duplicate: true, watches: [] as string[] };
      }
      const usage = this.payloadUsage();
      if (usage.bytes + raw.length > usage.maxBytes || usage.count >= usage.maxCount) throw new Error("github_storage_full");
      const summary = summarize(endpointId, headers, raw, payload);
      const inserted = this.db.prepare("INSERT INTO deliveries(endpoint_id,delivery_id,digest,value,raw) VALUES(?,?,?,?,?)").run(endpointId, headers.deliveryId, digest, "{}", raw);
      const record: Delivery = { sequence: Number(inserted.lastInsertRowid), ...summary };
      this.db.prepare("UPDATE deliveries SET value=? WHERE sequence=?").run(JSON.stringify(record), record.sequence);
      const watches = this.watches().filter(watch => matches(watch.filter, record, payload)).map(watch => watch.id);
      for (const id of watches) this.db.prepare("INSERT INTO watch_matches VALUES(?,?)").run(id, record.sequence);
      endpoint.accepted++; endpoint.lastDeliveryAt = record.receivedAt; endpoint.lastFailure = null;
      const target = endpoint.target.kind === "repository" ? object(payload.repository) : endpoint.target.kind === "organization" ? object(payload.organization)
        : endpoint.target.kind === "enterprise" ? object(payload.enterprise) : endpoint.target.kind === "sponsors_listing" ? object(object(payload.sponsorship).sponsorable) : {};
      if (typeof target.id === "number" && Number.isSafeInteger(target.id) && target.id > 0) endpoint.boundTargetId ??= target.id;
      if (headers.event === "ping") endpoint.lastPingAt = record.receivedAt;
      this.saveEndpoint(endpoint);
      return { record, duplicate: false, watches };
    });
  }
  private deliveryRow(sequence: number): DeliveryRow {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE sequence=?").get(sequence) as DeliveryRow | undefined;
    if (!row) throw new Error("github_delivery_not_found"); return row;
  }
  getDelivery(sequence: number): Delivery { return JSON.parse(this.deliveryRow(sequence).value); }
  readPayload(sequence: number, offset: number, limit: number) {
    const row = this.deliveryRow(sequence), record = JSON.parse(row.value) as Delivery;
    const text = row.raw ? Buffer.from(row.raw).toString("utf8") : "";
    return { sequence, text: text.slice(offset, offset + limit), encoding: "utf8" as const, totalChars: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : null, sha256: record.payloadSha256, cleared: row.raw === null };
  }
  listDeliveries(input: { after: number; through?: number; limit: number; filter: Filter }) {
    const through = Math.min(input.through ?? this.latest(), this.latest());
    if (through < input.after) throw new Error("github_cursor_invalid");
    // SQL performs the indexed cheap selections first; JSON predicates are bounded by the retained 10,000-payload budget.
    const where = ["sequence>?", "sequence<=?"], params: Array<string | number> = [input.after, through];
    if (input.filter.endpointIds) { where.push(`endpoint_id IN (${input.filter.endpointIds.map(() => "?").join(",")})`); params.push(...input.filter.endpointIds); }
    const rows = this.db.prepare(`SELECT * FROM deliveries WHERE ${where.join(" AND ")} ORDER BY sequence`).iterate(...params) as Iterable<DeliveryRow>;
    const entries: Delivery[] = [];
    let scanned = input.after, bytes = 0, truncated = false;
    for (const row of rows) {
      if (entries.length === input.limit) { truncated = true; break; }
      const record = JSON.parse(row.value) as Delivery;
      if (!(input.filter.predicates?.length && row.raw === null) && matches(input.filter, record, row.raw && input.filter.predicates?.length ? decodePayload(row.raw, record.contentType) : null)) {
        const size = Buffer.byteLength(row.value);
        if (entries.length && bytes + size > 1_000_000) { truncated = true; break; }
        entries.push(record); bytes += size;
      }
      scanned = row.sequence;
    }
    return { entries, after: input.after, through, nextCursor: truncated && scanned < through ? scanned : null };
  }
  getWatch(id: string, includeRemoved = false): Watch {
    const row = this.db.prepare("SELECT value,removed FROM watches WHERE id=?").get(id) as { value: string; removed: number } | undefined;
    if (!row || row.removed && !includeRemoved) throw new Error("github_watch_not_found"); return JSON.parse(row.value);
  }
  watches(): Watch[] { return (this.db.prepare("SELECT value FROM watches WHERE removed=0 ORDER BY id").all() as { value: string }[]).map(row => JSON.parse(row.value)); }
  createWatch(input: z.infer<typeof watchCreate>): Watch {
    return this.transaction(() => {
      const digest = stateHash(input);
      const old = this.db.prepare("SELECT digest,value,removed FROM watches WHERE id=?").get(input.id) as { digest: string; value: string; removed: number } | undefined;
      if (old) { if (old.digest !== digest || old.removed) throw new Error("github_watch_id_conflict"); return JSON.parse(old.value); }
      if (this.watches().length >= 128) throw new Error("github_watch_capacity");
      for (const id of input.filter.endpointIds ?? []) this.getEndpoint(id);
      const startAfter = input.start === "now" ? this.latest() : input.start;
      if (startAfter > this.latest()) throw new Error("github_cursor_ahead");
      const now = new Date().toISOString();
      const value: Watch = { id: input.id, label: input.label, filter: input.filter, enabled: true, revision: 1, startAfter, acknowledgedThrough: startAfter,
        createdAt: now, updatedAt: now, scope: `watch:${input.id}` };
      this.db.prepare("INSERT INTO watches(id,digest,value) VALUES(?,?,?)").run(input.id, digest, JSON.stringify(value));
      for (const row of this.db.prepare("SELECT * FROM deliveries WHERE sequence>? ORDER BY sequence").iterate(startAfter) as Iterable<DeliveryRow>) {
        const record = JSON.parse(row.value) as Delivery;
        if (input.filter.predicates?.length && row.raw === null) continue;
        if (matches(input.filter, record, input.filter.predicates?.length ? decodePayload(row.raw!, record.contentType) : null))
          this.db.prepare("INSERT INTO watch_matches VALUES(?,?)").run(input.id, row.sequence);
      }
      return value;
    });
  }
  updateWatch(id: string, expectedRevision: number, patch: { label?: string; enabled?: boolean }): Watch {
    const value = this.getWatch(id);
    if (value.revision !== expectedRevision) throw new Error("github_watch_revision_changed");
    Object.assign(value, patch); value.revision++; value.updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE watches SET value=? WHERE id=?").run(JSON.stringify(value), id); return value;
  }
  removeWatch(id: string): void {
    this.getWatch(id, true); this.db.prepare("UPDATE watches SET removed=1 WHERE id=?").run(id);
  }
  acknowledge(id: string, through: number, expectedAcknowledgedThrough: number): Watch {
    const value = this.getWatch(id);
    if (through === value.acknowledgedThrough) return value;
    if (value.acknowledgedThrough !== expectedAcknowledgedThrough) throw new Error("github_watch_cursor_changed");
    if (through < value.acknowledgedThrough || through > this.latest()) throw new Error("github_cursor_invalid");
    value.acknowledgedThrough = through;
    // Consumption is independent of configuration revisions.
    this.db.prepare("UPDATE watches SET value=? WHERE id=?").run(JSON.stringify(value), id); return value;
  }
  readWatch(id: string, limit: number, after?: number) {
    const watch = this.getWatch(id), cursor = after ?? watch.acknowledgedThrough;
    if (cursor < watch.startAfter || cursor > this.latest()) throw new Error("github_cursor_invalid");
    const through = (this.db.prepare("SELECT COALESCE(MAX(sequence),?) AS value FROM watch_matches WHERE watch_id=?").get(watch.startAfter, id) as { value: number }).value;
    const rows = this.db.prepare("SELECT d.value FROM watch_matches m JOIN deliveries d ON d.sequence=m.sequence WHERE m.watch_id=? AND m.sequence>? ORDER BY m.sequence LIMIT ?").all(id, cursor, limit + 1) as { value: string }[];
    const entries: Delivery[] = [];
    let chars = 0;
    for (const row of rows.slice(0, limit)) {
      // Keep ordinary snapshots inside the subscription owner's 16k input budget.
      // At least one record is returned; pathological summaries use its existing bounded read pointer.
      if (entries.length && chars + row.value.length > 10_000) break;
      entries.push(JSON.parse(row.value) as Delivery); chars += row.value.length;
    }
    const pending = (this.db.prepare("SELECT COUNT(*) AS value FROM watch_matches WHERE watch_id=? AND sequence>?").get(id, watch.acknowledgedThrough) as { value: number }).value;
    return { watch, entries, pending, through, nextCursor: rows.length > entries.length ? entries.at(-1)!.sequence : null };
  }
  historyPlan(sequences: number[]) {
    const rows = [...new Set(sequences)].sort((a, b) => a - b).map(sequence => this.deliveryRow(sequence));
    return this.maintenance.plan({ subject: null, action: "payload_clear", revision: stateHash(rows.map(row => [row.sequence, row.digest, row.raw !== null])),
      resources: rows.map(row => String(row.sequence)), blockedBy: [],
      retained: ["Delivery identity, raw-body digest, bounded summaries and frozen watch matches remain; pending watch entries are not acknowledged", "SQLite may retain freed pages until separate offline maintenance; this is logical payload removal, not secure erasure"],
      regeneration: ["Duplicate redelivery returns the retained receipt without restoring cleared bytes; GitHub redelivery is explicit and cannot guarantee recovery"] }, { sequences: rows.map(row => row.sequence) });
  }
  clearHistory(input: StateApplyInput) {
    return this.maintenance.atomic(input, (plan, payload) => {
      const rows = (payload as { sequences: number[] }).sequences.map(sequence => this.deliveryRow(sequence));
      if (plan.action !== "payload_clear" || plan.revision !== stateHash(rows.map(row => [row.sequence, row.digest, row.raw !== null]))) throw new Error("github_history_revision_changed");
    }, payload => (payload as { sequences: number[] }).sequences.map(sequence => {
      const value = this.getDelivery(sequence); value.payloadClearedAt ??= new Date().toISOString();
      this.db.prepare("UPDATE deliveries SET raw=NULL,value=? WHERE sequence=?").run(JSON.stringify(value), sequence);
      return { resource: String(sequence), outcome: "removed" as const, detail: "Original payload cleared; receipt, summary and watch matches retained" };
    }));
  }
  saveHookPlan(plan: z.infer<typeof hookPlan>): void {
    this.db.prepare("DELETE FROM hook_plans WHERE expires<?").run(Date.now());
    if ((this.db.prepare("SELECT COUNT(*) AS n FROM hook_plans").get() as { n: number }).n >= 1000) throw new Error("github_plan_capacity");
    this.db.prepare("INSERT INTO hook_plans VALUES(?,?,?)").run(plan.id, Date.parse(plan.expiresAt), JSON.stringify(plan));
  }
  getHookPlan(id: string): z.infer<typeof hookPlan> {
    const row = this.db.prepare("SELECT value,expires FROM hook_plans WHERE id=?").get(id) as { value: string; expires: number } | undefined;
    if (!row || row.expires < Date.now()) throw new Error("github_hook_plan_missing_or_expired"); return hookPlan.parse(JSON.parse(row.value));
  }
  remoteReceipt(requestId: string): RemoteReceipt | null {
    const row = this.db.prepare("SELECT value FROM remote_requests WHERE id=?").get(requestId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  existingRemote(requestId: string, input: unknown): RemoteReceipt | null {
    const row = this.db.prepare("SELECT digest,value FROM remote_requests WHERE id=?").get(requestId) as { digest: string; value: string } | undefined;
    if (!row) return null;
    if (row.digest !== stateHash(input)) throw new Error("github_request_id_conflict"); return JSON.parse(row.value);
  }
  beginRemote(receipt: RemoteReceipt, input: unknown): void {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM remote_requests WHERE json_extract(value,'$.endpointId')=? AND json_extract(value,'$.status')='running'").get(receipt.endpointId)) throw new Error("github_endpoint_busy");
      const planId = (input as { planId?: string }).planId;
      if (planId && !this.db.prepare("DELETE FROM hook_plans WHERE id=?").run(planId).changes) throw new Error("github_hook_plan_missing_or_consumed");
      this.db.prepare("INSERT INTO remote_requests VALUES(?,?,?)").run(receipt.requestId, stateHash(input), JSON.stringify(receipt));
    });
  }
  finishRemote(receipt: RemoteReceipt): RemoteReceipt {
    this.db.prepare("UPDATE remote_requests SET value=? WHERE id=?").run(JSON.stringify(receipt), receipt.requestId); return receipt;
  }
  bindHook(endpointId: string, hookId: number): void {
    const value = this.getEndpoint(endpointId); value.managedHookId = hookId; this.saveEndpoint(value);
  }
  close(): void { this.db.close(); }
}
