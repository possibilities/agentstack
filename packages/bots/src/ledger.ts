import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class BotLedger {
  private readonly db: DatabaseSync;

  constructor(readonly root: string) {
    let info: Stats | undefined;
    try {
      info = lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info === undefined) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    } else if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`bots root is not a directory: ${root}`);
    }
    chmodSync(root, 0o700);
    const file = join(root, "ledger.sqlite");
    try {
      closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    const legacyOwnership = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owned_workspaces'").get();
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bots (number INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS owned_workspaces (id TEXT PRIMARY KEY);
    `);
    if (legacyOwnership) this.db.exec("INSERT OR IGNORE INTO owned_workspaces (id) SELECT 'bot-' || number FROM bots");
  }

  close(): void {
    this.db.close();
  }

  ownsWorkspace(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM owned_workspaces WHERE id = ?").get(id));
  }

  ownWorkspace(id: string): void {
    this.db.prepare("INSERT OR IGNORE INTO owned_workspaces (id) VALUES (?)").run(id);
  }

  forgetWorkspace(id: string): void {
    this.db.prepare("DELETE FROM owned_workspaces WHERE id = ?").run(id);
  }

  has(id: string): boolean {
    if (!/^bot-[1-9][0-9]*$/.test(id)) return false;
    const number = Number(id.slice("bot-".length));
    if (!Number.isSafeInteger(number) || number < 1) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM bots WHERE number = ?").get(number));
  }

  remove(id: string): void {
    const number = Number(id.slice("bot-".length));
    if (!Number.isSafeInteger(number) || number < 1 || !this.db.prepare("DELETE FROM bots WHERE number = ?").run(number).changes) {
      throw new Error(`unknown bot: ${id}`);
    }
  }

  ids(): string[] {
    return (this.db.prepare("SELECT number FROM bots ORDER BY number").all() as Array<{ number: number }>)
      .map(({ number }) => `bot-${number}`);
  }

  reserve(claim: (id: string) => boolean, ownsWorkspace = true): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (;;) {
        const result = this.db.prepare("INSERT INTO bots DEFAULT VALUES").run();
        const id = `bot-${result.lastInsertRowid}`;
        if (claim(id)) {
          if (ownsWorkspace) this.ownWorkspace(id);
          this.db.exec("COMMIT");
          return id;
        }
        this.db.prepare("DELETE FROM bots WHERE number = ?").run(result.lastInsertRowid);
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
