import { DatabaseSync } from "node:sqlite";

/** Small compatibility surface retaining the domain's SQL and schema. */
export class Database {
  private readonly connection: DatabaseSync;
  private depth = 0;
  private sequence = 0;

  constructor(path: string, options: { readonly?: boolean; strict?: boolean; create?: boolean } = {}) {
    this.connection = new DatabaseSync(path, { readOnly: options.readonly ?? false });
    this.connection.exec("PRAGMA busy_timeout=5000");
  }

  exec(sql: string): void { this.connection.exec(sql); }
  run(sql: string, parameters?: any[]): void {
    if (parameters) this.query(sql).run(...parameters);
    else this.exec(sql);
  }
  query(sql: string): {
    all(...parameters: any[]): any[];
    get(...parameters: any[]): any;
    run(...parameters: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  } {
    const statement = this.connection.prepare(sql);
    return {
      all: (...parameters) => statement.all(...parameters),
      get: (...parameters) => statement.get(...parameters) ?? null,
      run: (...parameters) => statement.run(...parameters),
    };
  }

  transaction<T>(body: () => T): (() => T) & { immediate(): T; deferred(): T; exclusive(): T } {
    const run = (mode: string): T => {
      const nested = this.depth > 0;
      const savepoint = `brain_${++this.sequence}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
      this.depth++;
      try {
        const result = body();
        this.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        this.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
        if (nested) this.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally { this.depth--; }
    };
    return Object.assign(() => run("DEFERRED"), {
      immediate: () => run("IMMEDIATE"), deferred: () => run("DEFERRED"), exclusive: () => run("EXCLUSIVE"),
    });
  }
  close(): void { this.connection.close(); }
}

export function openReadonlyDatabase(path: string): Database {
  return new Database(path, { readonly: true, strict: true });
}
