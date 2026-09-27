import { DatabaseSync } from "node:sqlite";

// Preserve the original store's small Bun SQLite surface while using the
// owner's Node runtime. The on-disk SQLite schema and SQL stay unchanged.
export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string, _options: { create: true }) {
    this.db = new DatabaseSync(path);
  }

  run(sql: string): void { this.db.exec(sql); }
  query(sql: string): {
    all(...parameters: any[]): any[];
    get(...parameters: any[]): any;
    run(...parameters: any[]): any;
  } {
    const statement = this.db.prepare(sql);
    return {
      all: (...parameters) => statement.all(...parameters),
      get: (...parameters) => statement.get(...parameters) ?? null,
      run: (...parameters) => statement.run(...parameters),
    };
  }
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec("BEGIN");
      try {
        const value = fn();
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    };
  }
  close(): void { this.db.close(); }
}
