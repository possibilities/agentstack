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
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bots (number INTEGER PRIMARY KEY AUTOINCREMENT);
    `);
  }

  close(): void {
    this.db.close();
  }

  has(id: string): boolean {
    const number = Number(id.slice("bot-".length));
    if (!Number.isSafeInteger(number) || number < 1) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM bots WHERE number = ?").get(number));
  }

  ids(): string[] {
    return (this.db.prepare("SELECT number FROM bots ORDER BY number").all() as Array<{ number: number }>)
      .map(({ number }) => `bot-${number}`);
  }

  reserve(claim: (id: string) => boolean): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (;;) {
        const result = this.db.prepare("INSERT INTO bots DEFAULT VALUES").run();
        const id = `bot-${result.lastInsertRowid}`;
        if (claim(id)) {
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
