import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, chmodSync, lstatSync } from "node:fs";
import { lstat, readdir, open, mkdir, writeFile, rename, rm, realpath } from "node:fs/promises";
import { join, relative, basename, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { appServerSocket } from "./threads.js";
import type { ServerView } from "./supervisor.js";
import WebSocket from "ws";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatRow = { botId: string; threadId: string; parentThreadId: string | null; title: string; cwd: string; createdAt: string; updatedAt: string; messageCount: number };
export type ChatHit = ChatRow & { line: number; role: string; snippet: string; score: number };
export type QueuedChat = { id: string; botId: string; threadId: string; input: unknown[]; state: "pending" | "dispatching" | "sent" | "unknown" | "cancelled"; turnId: string | null; issue: string | null };
async function fileText(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile("utf8"); } finally { await handle.close(); }
}

/** An entirely derived, owner-private index. Only rollouts below a Bot's history directory are admitted. */
export class ChatIndex {
  private db: DatabaseSync;
  constructor(private readonly stateDir: string) {
    const path = join(stateDir, "chats.sqlite");
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(path).isFile()) throw new Error("chat index is not a regular file");
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS chats (
        bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_id TEXT, path TEXT NOT NULL,
        size INTEGER NOT NULL, mtime REAL NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message_count INTEGER NOT NULL,
        PRIMARY KEY(bot_id, thread_id));
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        line INTEGER NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(bot_id, thread_id, line);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,body) VALUES(new.id,new.body); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,body) VALUES('delete',old.id,old.body); END;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_queue (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, input TEXT NOT NULL,
      state TEXT NOT NULL, turn_id TEXT, issue TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_queue_next ON chat_queue(bot_id,thread_id,state,created_at);`);
    this.db.prepare("UPDATE chat_queue SET state='unknown',issue='Owner restarted during dispatch; inspect the thread before retrying' WHERE state='dispatching'").run();
  }

  close(): void { this.db.close(); }
  removeBot(botId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM messages WHERE bot_id=?").run(botId);
      this.db.prepare("DELETE FROM chats WHERE bot_id=?").run(botId);
      this.db.prepare("DELETE FROM chat_queue WHERE bot_id=?").run(botId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Scan without following symlinks. Failure retains existing rows and is surfaced, not confused with empty history. */
  async refresh(botId: string, mainThreadId: string | null): Promise<void> {
    const history = join(this.stateDir, "history");
    const root = join(history, botId);
    const found = new Set<string>();
    const candidates: { path: string; id: string; parent: string | null; size: number; mtime: number }[] = [];
    const visit = async (dir: string, sharedTop = false): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Legacy shared history was date-partitioned. Never walk another Bot's
          // private subtree just because it resides beneath history/.
          if (!sharedTop || /^\d{4}$/.test(entry.name)) await visit(path);
          continue;
        }
        if (!entry.isFile() || !/^rollout-.*-[0-9a-f-]{36}\.jsonl$/i.test(entry.name)) continue;
        const stat = await lstat(path);
        if (!stat.isFile()) continue;
        const existing = this.db.prepare("SELECT thread_id AS id,parent_id AS parent,size,mtime FROM chats WHERE bot_id=? AND path=?").get(botId, path) as
          { id: string; parent: string | null; size: number; mtime: number } | undefined;
        if (existing?.size === stat.size && existing.mtime === stat.mtimeMs) {
          candidates.push({ path, id: existing.id, parent: existing.parent, size: stat.size, mtime: stat.mtimeMs });
          continue;
        }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let prefix: string;
        try { const buffer = Buffer.alloc(65536); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); prefix = buffer.subarray(0, bytesRead).toString("utf8"); }
        finally { await file.close(); }
        let first: RecordValue;
        try { first = object(JSON.parse(prefix.split("\n", 1)[0])); } catch { continue; }
        const meta = object(first.payload);
        const id = text(meta.id);
        if (first.type !== "session_meta" || !uuid.test(id) || entry.name.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1] !== id) continue;
        candidates.push({ path, id, parent: text(meta.parent_thread_id) || null, size: stat.size, mtime: stat.mtimeMs });
      }
    };
    const scanRoot = async (dir: string, sharedTop = false): Promise<void> => {
      let stat;
      try { stat = await lstat(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!stat.isDirectory()) throw new Error(`chat history root is not a real directory: ${dir}`);
      await visit(dir, sharedTop);
    };
    // Check the shared parent before resolving the private root beneath it.
    let historyStat;
    try { historyStat = await lstat(history); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (historyStat && !historyStat.isDirectory()) throw new Error(`chat history root is not a real directory: ${history}`);
    await scanRoot(root);
    if (mainThreadId) {
      await scanRoot(history, true);
    }
    const parents = new Map(candidates.map((candidate) => [candidate.id, candidate.parent]));
    const sanctioned = (threadId: string): boolean => {
      const visited = new Set<string>();
      let id: string | null = threadId;
      while (id && !visited.has(id)) {
        if (id === mainThreadId) return true;
        visited.add(id); id = parents.get(id) ?? null;
      }
      return false;
    };
    for (const candidate of candidates) {
      if (!sanctioned(candidate.id)) continue;
      const { path, id, parent } = candidate;
      found.add(path);
      const existing = this.db.prepare("SELECT size,mtime FROM chats WHERE bot_id=? AND path=?").get(botId, path) as { size: number; mtime: number } | undefined;
      if (existing?.size === candidate.size && existing.mtime === candidate.mtime) continue;
      const content = await fileText(path);
      const lines = content.split("\n");
      const meta = object(object(JSON.parse(lines[0] ?? "null")).payload);
      const messages: { line: number; role: string; body: string }[] = [];
      let title = "";
      let updated = text(meta.timestamp);
      const contentText = (value: unknown): string => Array.isArray(value) ? value.map((part: unknown) => text(object(part).text)).filter(Boolean).join("\n") : "";
      const outputText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? contentText(value) :
        typeof object(value).content === "string" ? text(object(value).content) : contentText(object(value).content);
      for (let i = 1; i < lines.length; i++) {
        let record: RecordValue;
        try { record = object(JSON.parse(lines[i]!)); } catch { continue; }
        if (record.type !== "response_item") continue;
        const payload = object(record.payload);
        const role = payload.type === "message" ? text(payload.role) : text(payload.type);
        const body = [contentText(payload.content), contentText(payload.summary), text(payload.name), text(payload.arguments), text(payload.input), outputText(payload.output)]
          .filter(Boolean).join("\n");
        if (!body) continue;
        if (role === "user" && !title && !["<environment_context>", "<recommended_plugins>", "<user_instructions>", "# AGENTS.md"].some((marker) => body.startsWith(marker))) title = body.replace(/\s+/g, " ").slice(0, 120);
        updated = text(record.timestamp) || updated;
        messages.push({ line: i + 1, role, body: body.slice(0, 16384) });
      }
      this.db.exec("BEGIN");
      try {
        this.db.prepare("DELETE FROM messages WHERE bot_id=? AND thread_id=?").run(botId, id);
        this.db.prepare(`INSERT INTO chats(bot_id,thread_id,parent_id,path,size,mtime,title,cwd,created_at,updated_at,message_count)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,thread_id) DO UPDATE SET
          parent_id=excluded.parent_id,path=excluded.path,size=excluded.size,mtime=excluded.mtime,
          title=excluded.title,cwd=excluded.cwd,created_at=excluded.created_at,updated_at=excluded.updated_at,message_count=excluded.message_count`)
          .run(botId, id, parent, path, candidate.size, candidate.mtime, title || "(untitled)", text(meta.cwd), text(meta.timestamp), updated, messages.length);
        const insert = this.db.prepare("INSERT INTO messages(bot_id,thread_id,line,role,body) VALUES(?,?,?,?,?)");
        for (const message of messages) insert.run(botId, id, message.line, message.role, message.body);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    for (const row of this.db.prepare("SELECT thread_id,path FROM chats WHERE bot_id=?").all(botId) as { thread_id: string; path: string }[]) {
      if (!found.has(row.path)) {
        this.db.prepare("DELETE FROM messages WHERE bot_id=? AND thread_id=?").run(botId, row.thread_id);
        this.db.prepare("DELETE FROM chats WHERE bot_id=? AND thread_id=?").run(botId, row.thread_id);
      }
    }
  }

  private row(botId: string, threadId: string): (ChatRow & { path: string }) | undefined {
    return this.db.prepare(`SELECT bot_id AS botId,thread_id AS threadId,parent_id AS parentThreadId,path,title,cwd,
      created_at AS createdAt,updated_at AS updatedAt,message_count AS messageCount FROM chats WHERE bot_id=? AND thread_id=?`)
      .get(botId, threadId) as (ChatRow & { path: string }) | undefined;
  }
  allowed(botId: string, threadId: string, mainThreadId: string | null): boolean {
    if (!mainThreadId) return false;
    const visited = new Set<string>();
    let id: string | null = threadId;
    while (id && !visited.has(id)) {
      if (id === mainThreadId) return Boolean(this.row(botId, id));
      visited.add(id);
      id = this.row(botId, id)?.parentThreadId ?? null;
    }
    return false;
  }
  list(botId: string, mainThreadId: string | null, limit: number, offset: number): ChatRow[] {
    return (this.db.prepare(`SELECT thread_id AS threadId FROM chats WHERE bot_id=? ORDER BY updated_at DESC,thread_id LIMIT ? OFFSET ?`)
      .all(botId, 100000, 0) as { threadId: string }[])
      .filter((row) => this.allowed(botId, row.threadId, mainThreadId)).slice(offset, offset + limit)
      .map((row) => { const { path: _path, ...chat } = this.row(botId, row.threadId)!; return chat; });
  }
  search(botId: string, mainThreadId: string | null, query: string, limit: number, offset: number): ChatHit[] {
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term}"`).join(" ");
    const rows = this.db.prepare(`SELECT m.thread_id AS threadId,m.line,m.role,
      snippet(messages_fts,0,'[',']',' … ',48) AS snippet,bm25(messages_fts) AS score
      FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.bot_id=? ORDER BY score LIMIT 50000`).all(match, botId) as
      { threadId: string; line: number; role: string; snippet: string; score: number }[];
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.threadId) || !this.allowed(botId, row.threadId, mainThreadId)) return false;
      seen.add(row.threadId); return true;
    }).slice(offset, offset + limit).map((row) => {
      const { path: _path, ...chat } = this.row(botId, row.threadId)!;
      return { ...chat, line: row.line, role: row.role, snippet: row.snippet.slice(0, 2048), score: row.score };
    });
  }
  async records(botId: string, threadId: string, mainThreadId: string | null, after: number, limit: number): Promise<{ records: { line: number; timestamp: string; type: string; payload: unknown; truncated: boolean }[]; nextLine: number | null }> {
    if (!this.allowed(botId, threadId, mainThreadId)) throw new Error("thread is not in this Bot's main-thread lineage");
    const row = this.row(botId, threadId)!;
    const privateRelative = relative(join(this.stateDir, "history", botId), row.path);
    const sharedRelative = relative(join(this.stateDir, "history"), row.path);
    if ((privateRelative.startsWith("..") || isAbsolute(privateRelative)) && !/^\d{4}\//.test(sharedRelative)) throw new Error("invalid rollout path");
    const lines = (await fileText(row.path)).split("\n");
    const records: { line: number; timestamp: string; type: string; payload: unknown; truncated: boolean }[] = [];
    let nextLine: number | null = null;
    let chars = 0;
    for (let i = after; i < lines.length; i++) {
      let value: RecordValue;
      try { value = object(JSON.parse(lines[i]!)); } catch { continue; }
      if (value.type !== "response_item" && value.type !== "event_msg") continue;
      if (records.length === limit) { nextLine = i; break; }
      const truncated = lines[i]!.length > 65_536 || chars + lines[i]!.length > 500_000;
      if (!truncated) chars += lines[i]!.length;
      records.push({ line: i + 1, timestamp: text(value.timestamp), type: text(value.type), payload: truncated ? null : value.payload, truncated });
    }
    return { records, nextLine };
  }
  async recordChunk(botId: string, threadId: string, mainThreadId: string | null, line: number, offset: number, length: number): Promise<{ text: string; totalChars: number; nextOffset: number | null }> {
    if (!this.allowed(botId, threadId, mainThreadId)) throw new Error("thread is not in this Bot's main-thread lineage");
    const row = this.row(botId, threadId)!;
    const source = (await fileText(row.path)).split("\n")[line - 1];
    if (!source) throw new Error("rollout line not found; refresh chat history");
    const parsed = object(JSON.parse(source));
    if (parsed.type !== "response_item" && parsed.type !== "event_msg") throw new Error("line is not a chat record");
    if (offset > source.length) throw new Error("offset exceeds record length");
    const end = Math.min(source.length, offset + length);
    return { text: source.slice(offset, end), totalChars: source.length, nextOffset: end < source.length ? end : null };
  }
  enqueue(botId: string, threadId: string, id: string, input: unknown[]): QueuedChat {
    const serialized = JSON.stringify(input);
    const existing = this.db.prepare("SELECT bot_id AS botId,thread_id AS threadId,input FROM chat_queue WHERE id=?").get(id) as { botId: string; threadId: string; input: string } | undefined;
    if (existing && (existing.botId !== botId || existing.threadId !== threadId || existing.input !== serialized)) throw new Error("queue id was already used with different content or destination");
    if (!existing) this.db.prepare("INSERT INTO chat_queue(id,bot_id,thread_id,input,state,created_at) VALUES(?,?,?,?,'pending',?)").run(id, botId, threadId, serialized, Date.now());
    return this.queued(id)!;
  }
  queued(id: string): QueuedChat | null {
    const row = this.db.prepare("SELECT id,bot_id AS botId,thread_id AS threadId,input,state,turn_id AS turnId,issue FROM chat_queue WHERE id=?").get(id) as (Omit<QueuedChat, "input"> & { input: string }) | undefined;
    return row ? { ...row, input: JSON.parse(row.input) as unknown[] } : null;
  }
  queueList(botId: string, threadId: string): QueuedChat[] {
    return (this.db.prepare("SELECT id FROM chat_queue WHERE bot_id=? AND thread_id=? ORDER BY created_at,id").all(botId, threadId) as { id: string }[]).map(({ id }) => this.queued(id)!);
  }
  nextQueued(botId: string, threadId: string): QueuedChat | null {
    const blocked = this.db.prepare("SELECT id FROM chat_queue WHERE bot_id=? AND thread_id=? AND state IN ('unknown','dispatching') LIMIT 1").get(botId, threadId);
    if (blocked) return null;
    const row = this.db.prepare("SELECT id FROM chat_queue WHERE bot_id=? AND thread_id=? AND state='pending' ORDER BY created_at,id LIMIT 1").get(botId, threadId) as { id: string } | undefined;
    return row ? this.queued(row.id) : null;
  }
  pendingPairs(botId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT thread_id AS threadId FROM chat_queue WHERE bot_id=? AND state='pending'").all(botId) as { threadId: string }[]).map((row) => row.threadId);
  }
  setQueued(id: string, state: QueuedChat["state"], turnId: string | null = null, issue: string | null = null): QueuedChat {
    this.db.prepare("UPDATE chat_queue SET state=?,turn_id=?,issue=? WHERE id=?").run(state, turnId, issue, id);
    return this.queued(id)!;
  }
}

/** Persist first, dispatch only when idle, never retry a possibly accepted turn. */
export class ChatQueue {
  private draining = new Set<string>();
  private pendingWakes = new Set<string>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private tasks = new Set<Promise<void>>();
  private closed = false;
  onChange: ((botId: string) => void) | undefined;
  constructor(private readonly index: ChatIndex, private readonly bot: (id: string) => ServerView | undefined) {}
  wake(botId: string, threadId: string): void {
    if (this.closed) return;
    const key = `${botId}:${threadId}`;
    const retry = this.retries.get(key);
    if (retry) { clearTimeout(retry); this.retries.delete(key); }
    if (this.draining.has(key)) { this.pendingWakes.add(key); return; }
    this.draining.add(key);
    const task = this.drain(botId, threadId).catch((error) => console.error(`chat queue ${key}: ${error}`)).finally(() => {
      this.draining.delete(key);
      if (this.pendingWakes.delete(key)) this.wake(botId, threadId);
    });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }
  wakeBot(botId: string): void { if (!this.closed) for (const id of this.index.pendingPairs(botId)) this.wake(botId, id); }
  async close(): Promise<void> {
    this.closed = true;
    for (const retry of this.retries.values()) clearTimeout(retry);
    this.retries.clear();
    await Promise.all(this.tasks);
  }
  private async drain(botId: string, threadId: string): Promise<void> {
    while (!this.closed) {
      const next = this.index.nextQueued(botId, threadId);
      if (!next) return;
      const bot = this.bot(botId);
      if (!bot || !this.index.allowed(botId, threadId, bot.mainThreadId) || bot.state !== "running" || bot.recoveryIssue || !bot.runningAccount) return;
      let status: unknown;
      try { status = object((await chatRpc(live(bot), "thread/read", { threadId })).thread).status; }
      catch {
        // No submission was attempted. Retry a transient read even if no further
        // socket notification arrives; a stop or close cancels dispatch safely.
        const key = `${botId}:${threadId}`;
        if (!this.closed && !this.retries.has(key)) {
          const timer = setTimeout(() => { this.retries.delete(key); this.wake(botId, threadId); }, 1_000);
          timer.unref();
          this.retries.set(key, timer);
        }
        return;
      }
      if (text(object(status).type) !== "idle") return;
      try {
        // A cancellation may have arrived during the read. Check again before submission.
        if (this.closed) return;
        if (this.index.queued(next.id)?.state !== "pending") continue;
        this.index.setQueued(next.id, "dispatching");
        this.onChange?.(botId);
        const result = await chatRpc(live(bot), "turn/start", { threadId, input: next.input, clientUserMessageId: next.id });
        this.index.setQueued(next.id, "sent", text(object(result.turn).id));
        this.onChange?.(botId);
        return; // Wait for the turn/completed invalidation before dispatching the next.
      } catch (error) {
        // The request may have reached Codex. Never automatically resubmit it.
        this.index.setQueued(next.id, "unknown", null, String(error));
        this.onChange?.(botId);
        return;
      }
    }
  }
}

type Upload = { botId: string; id: string; name: string; bytes: number; sha256: string; offset: number; path: string | null };
/** Chunked, resumable file staging. An upload belongs to a Bot, never to an arbitrary client path. */
export class ChatUploads {
  private busy = new Set<string>();
  constructor(private readonly stateDir: string) {}
  private directory(botId: string, id: string): string { return join(this.stateDir, "chat-uploads", botId, id); }
  private async read(botId: string, id: string): Promise<Upload> {
    const data = JSON.parse(await fileText(join(this.directory(botId, id), "manifest.json"))) as Upload;
    if (data.botId !== botId || data.id !== id) throw new Error("upload ownership mismatch");
    return data;
  }
  async start(botId: string, id: string, name: string, bytes: number, sha256: string): Promise<Upload> {
    if (basename(name) !== name || name === "." || name === ".." || name === "content.part" || name === "manifest.json" || /[\x00-\x1f/\\]/.test(name)) throw new Error("upload name must be one safe filename");
    const dir = this.directory(botId, id);
    try { return await this.read(botId, id).then((old) => {
      if (old.name !== name || old.bytes !== bytes || old.sha256 !== sha256) throw new Error("upload id already used for different content");
      return old;
    }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const manifest: Upload = { botId, id, name, bytes, sha256, offset: 0, path: null };
    const part = await open(join(dir, "content.part"), "wx", 0o600);
    await part.close();
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    return manifest;
  }
  async status(botId: string, id: string): Promise<Upload> {
    const manifest = await this.read(botId, id);
    if (manifest.path) return manifest;
    let stat;
    try { stat = await lstat(join(this.directory(botId, id), "content.part")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Recovery after rename succeeded but before the final manifest was written.
      const path = join(this.directory(botId, id), manifest.name);
      const complete = await lstat(path);
      if (!complete.isFile() || complete.size !== manifest.bytes) throw new Error("finalized upload is invalid");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (createHash("sha256").update(await file.readFile()).digest("hex") !== manifest.sha256) throw new Error("finalized upload hash mismatch"); }
      finally { await file.close(); }
      const updated = { ...manifest, offset: manifest.bytes, path };
      await writeFile(join(this.directory(botId, id), "manifest.json"), JSON.stringify(updated), { mode: 0o600 });
      return updated;
    }
    if (!stat.isFile() || stat.size > manifest.bytes) throw new Error("upload part is invalid");
    return { ...manifest, offset: stat.size }; // Actual bytes, not a possibly interrupted acknowledgement.
  }
  async append(botId: string, id: string, offset: number, base64: string): Promise<Upload> {
    const key = `${botId}:${id}`;
    if (this.busy.has(key)) throw new Error("upload already being written; read status before retrying");
    this.busy.add(key);
    try {
      const manifest = await this.status(botId, id);
      if (manifest.path) throw new Error("upload already finalized");
      if (manifest.offset !== offset) throw new Error(`upload offset changed to ${manifest.offset}; read status before retrying`);
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length || buffer.length > 262144 || buffer.toString("base64") !== base64) throw new Error("chunk must be canonical base64 of 1..262144 bytes");
      if (offset + buffer.length > manifest.bytes) throw new Error("chunk exceeds declared upload size");
      const file = await open(join(this.directory(botId, id), "content.part"), constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        let written = 0;
        while (written < buffer.length) written += (await file.write(buffer, written, buffer.length - written, offset + written)).bytesWritten;
        await file.sync();
      } finally { await file.close(); }
      return { ...manifest, offset: offset + buffer.length };
    } finally { this.busy.delete(key); }
  }
  async finish(botId: string, id: string): Promise<Upload> {
    const key = `${botId}:${id}`;
    if (this.busy.has(key)) throw new Error("upload write is in progress");
    this.busy.add(key);
    try {
      const manifest = await this.status(botId, id);
      if (manifest.path) return manifest;
      if (manifest.offset !== manifest.bytes) throw new Error(`upload incomplete: ${manifest.offset}/${manifest.bytes} bytes`);
      const path = join(this.directory(botId, id), manifest.name);
      // Hash bytes, never the UTF-8 decoding used for JSON rollouts.
      const file = await open(join(this.directory(botId, id), "content.part"), constants.O_RDONLY | constants.O_NOFOLLOW);
      let digest: string;
      try { digest = createHash("sha256").update(await file.readFile()).digest("hex"); } finally { await file.close(); }
      if (digest !== manifest.sha256) throw new Error("upload SHA-256 does not match declared digest");
      await rename(join(this.directory(botId, id), "content.part"), path);
      const complete = { ...manifest, path };
      await writeFile(join(this.directory(botId, id), "manifest.json"), JSON.stringify(complete), { mode: 0o600 });
      return complete;
    } finally { this.busy.delete(key); }
  }
  async within(botId: string, path: string): Promise<boolean> {
    const root = await realpath(join(this.stateDir, "chat-uploads", botId)).catch(() => null);
    if (!root) return false;
    const absolute = await realpath(path);
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    const id = rel.split("/")[0];
    if (!id || !uuid.test(id)) return false;
    const saved = await this.read(botId, id).catch(() => null);
    return saved?.path ? (await realpath(saved.path).catch(() => null)) === absolute : false;
  }
  async removeBot(botId: string): Promise<void> { await rm(join(this.stateDir, "chat-uploads", botId), { recursive: true, force: true }); }
}

/** One RPC per connection. Closing before an acknowledgement is an unknown outcome for mutations. */
export async function chatRpc(url: string, method: string, params: RecordValue): Promise<RecordValue> {
  const ws = appServerSocket(url);
  return new Promise((resolve, reject) => {
    let stage = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${method}: timeout; if mutating, outcome is unknown—read thread state before retrying`)), 15000);
    const finish = (error?: Error, result?: RecordValue) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN) ws.close(); else ws.terminate();
      if (error) reject(error); else resolve(result ?? {});
    };
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agentstack-chats", version: "0.0.0" }, capabilities: { experimentalApi: true } } })));
    ws.on("message", (raw) => {
      let frame: RecordValue;
      try { frame = object(JSON.parse(String(raw))); } catch { return; }
      if (stage === 0 && frame.id === 1) {
        if (frame.error) { finish(new Error(`initialize: ${text(object(frame.error).message)}`)); return; }
        stage = 1;
        ws.send(JSON.stringify({ method: "initialized" }));
        ws.send(JSON.stringify({ id: 2, method, params }));
      } else if (stage === 1 && frame.id === 2) {
        if (frame.error) finish(new Error(`${method}: ${text(object(frame.error).message)}`));
        else finish(undefined, object(frame.result));
      }
    });
    ws.on("error", (error) => finish(new Error(`${method}: ${error.message}; if mutating, outcome may be unknown`)));
    ws.on("close", () => finish(new Error(`${method}: connection closed; if mutating, outcome is unknown—read thread state before retrying`)));
  });
}

export function live(bot: ServerView): string {
  if (bot.state !== "running" || !bot.url || bot.recoveryIssue || !bot.runningAccount) throw new Error("Bot is not a verified, account-bound running process");
  return bot.url;
}
