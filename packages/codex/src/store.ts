import { AuthStore } from "@agentstack/auth";

export type StoredServer = {
  id: string;
  pid: number | null;
  cwd: string;
  url: string | null;
  state: "running" | "stopped";
  codexBin: string;
  account: string | null;
  authVersion: number | null;
  runtimeRoot: string | null;
  mainThreadId: string | null;
  threadStarting: boolean;
};

export class StateStore extends AuthStore {
  constructor(stateDir: string) {
    super(stateDir);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY, pid INTEGER, cwd TEXT NOT NULL, url TEXT,
        state TEXT NOT NULL, codex_bin TEXT NOT NULL, account TEXT,
        auth_version INTEGER, runtime_root TEXT,
        main_thread_id TEXT, thread_starting INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Existing installations of the first SQLite-backed release have neither column.
    const serverColumns = this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
    if (!serverColumns.some(({ name }) => name === "auth_version")) this.db.exec("ALTER TABLE servers ADD COLUMN auth_version INTEGER");
    if (!serverColumns.some(({ name }) => name === "runtime_root")) this.db.exec("ALTER TABLE servers ADD COLUMN runtime_root TEXT");
    if (!serverColumns.some(({ name }) => name === "main_thread_id")) this.db.exec("ALTER TABLE servers ADD COLUMN main_thread_id TEXT");
    if (!serverColumns.some(({ name }) => name === "thread_starting")) this.db.exec("ALTER TABLE servers ADD COLUMN thread_starting INTEGER NOT NULL DEFAULT 0");
  }

  servers(): StoredServer[] {
    return (this.db.prepare("SELECT id, pid, cwd, url, state, codex_bin, account, auth_version, runtime_root, main_thread_id, thread_starting FROM servers").all() as Array<{
      id: string; pid: number | null; cwd: string; url: string | null; state: StoredServer["state"]; codex_bin: string; account: string | null; auth_version: number | null; runtime_root: string | null; main_thread_id: string | null; thread_starting: number;
    }>).map(({ codex_bin, auth_version, runtime_root, main_thread_id, thread_starting, ...row }) => ({
      ...row, codexBin: codex_bin, authVersion: auth_version, runtimeRoot: runtime_root,
      mainThreadId: main_thread_id, threadStarting: Boolean(thread_starting),
    }));
  }

  saveServer(server: StoredServer): void {
    this.db.prepare(`INSERT INTO servers (id, pid, cwd, url, state, codex_bin, account, auth_version, runtime_root, main_thread_id, thread_starting) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, cwd=excluded.cwd, url=excluded.url,
      state=excluded.state, codex_bin=excluded.codex_bin, account=excluded.account,
      auth_version=excluded.auth_version, runtime_root=excluded.runtime_root,
      main_thread_id=excluded.main_thread_id, thread_starting=excluded.thread_starting`).run(
      server.id, server.pid, server.cwd, server.url, server.state, server.codexBin, server.account, server.authVersion ?? null, server.runtimeRoot ?? null,
      server.mainThreadId ?? null, server.threadStarting ? 1 : 0,
    );
  }

  hasServer(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM servers WHERE id = ?").get(id)); }
}
