import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { application, definitions, evidence, validateValues } from "./catalog.js";
import { settingsPatch, type SettingsBackend, type SettingsPatch, type SettingsSnapshot, type SettingsLoaded, type SettingValues, type SettingsView } from "./schema.js";

/** The owning Package API supplies its private database and lifecycle fence. */
export class SettingsStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS managed_settings (subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, values_json TEXT NOT NULL,
      source TEXT NOT NULL, source_revision INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_settings_receipts (request_id TEXT PRIMARY KEY, intent TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_settings_loaded (subject TEXT PRIMARY KEY, instance TEXT NOT NULL, snapshot TEXT NOT NULL);`);
  }
  get(subject: string): SettingsSnapshot | null {
    const row = this.db.prepare("SELECT * FROM managed_settings WHERE subject=?").get(subject) as { revision: number; values_json: string; source: string; source_revision: number | null; updated_at: number } | undefined;
    return row ? { revision: row.revision, values: JSON.parse(row.values_json), source: row.source, sourceRevision: row.source_revision, updatedAt: row.updated_at } : null;
  }
  seed(subject: string, values: SettingValues, source: string, sourceRevision: number | null = null): SettingsSnapshot {
    this.db.prepare("INSERT OR IGNORE INTO managed_settings VALUES (?,0,?,?,?,?)").run(subject, JSON.stringify(values), source, sourceRevision, Date.now());
    return this.get(subject)!;
  }
  preview(subject: string, backend: SettingsBackend, input: SettingsPatch) {
    const patch = settingsPatch.parse(input);
    const current = this.get(subject);
    if (!current) throw new Error("Unknown settings subject");
    if (current.revision !== patch.expectedRevision) throw new Error("Settings revision conflict; reread before editing");
    const values = { ...current.values };
    for (const key of patch.reset ?? []) {
      if (!Object.hasOwn(definitions(backend), key)) throw new Error(`Unsupported setting: ${key}`);
      if (Object.hasOwn(patch.set ?? {}, key)) throw new Error(`Cannot set and reset the same setting: ${key}`);
      delete values[key];
    }
    Object.assign(values, patch.set);
    validateValues(backend, values);
    const changes = [...new Set([...Object.keys(current.values), ...Object.keys(values)])].filter((key) => !isDeepStrictEqual(current.values[key], values[key]))
      .map((key) => ({ key, beforeSet: Object.hasOwn(current.values, key), afterSet: Object.hasOwn(values, key), before: current.values[key] ?? null, after: values[key] ?? null, apply: application(key, backend) }));
    return { revision: current.revision, values, changes, issues: [] as string[] };
  }
  patch(subject: string, backend: SettingsBackend, input: SettingsPatch) {
    const patch = settingsPatch.parse(input);
    const intent = createHash("sha256").update(JSON.stringify([subject, backend, patch.expectedRevision,
      Object.entries(patch.set ?? {}).sort(([a], [b]) => a.localeCompare(b)), [...(patch.reset ?? [])].sort()])).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT intent,revision FROM managed_settings_receipts WHERE request_id=?").get(patch.requestId) as { intent: string; revision: number } | undefined;
      if (previous) {
        if (previous.intent !== intent) throw new Error("requestId was reused for another settings edit");
        this.db.exec("COMMIT");
        return { requestId: patch.requestId, revision: previous.revision, duplicate: true, applied: false as const };
      }
      const plan = this.preview(subject, backend, patch);
      const revision = plan.revision + (plan.changes.length ? 1 : 0);
      if (plan.changes.length) this.db.prepare("UPDATE managed_settings SET revision=?, values_json=?, updated_at=? WHERE subject=?")
        .run(revision, JSON.stringify(plan.values), Date.now(), subject);
      this.db.prepare("INSERT INTO managed_settings_receipts VALUES (?,?,?)").run(patch.requestId, intent, revision);
      this.db.exec("COMMIT");
      return { requestId: patch.requestId, revision, duplicate: false, applied: false as const };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  loaded(subject: string, instance?: string): SettingsLoaded | null {
    const row = this.db.prepare("SELECT instance,snapshot FROM managed_settings_loaded WHERE subject=?").get(subject) as { instance: string; snapshot: string } | undefined;
    return row && (instance === undefined || row.instance === instance) ? JSON.parse(row.snapshot) : null;
  }
  markLoaded(subject: string, instance: string, snapshot: SettingsSnapshot): void {
    this.db.prepare("INSERT INTO managed_settings_loaded VALUES (?,?,?) ON CONFLICT(subject) DO UPDATE SET instance=excluded.instance,snapshot=excluded.snapshot")
      .run(subject, instance, JSON.stringify({ ...snapshot, loadedAt: Date.now() }));
  }
  clearLoaded(subject: string): void { this.db.prepare("DELETE FROM managed_settings_loaded WHERE subject=?").run(subject); }
  remove(subject: string): void {
    this.db.prepare("DELETE FROM managed_settings WHERE subject=?").run(subject);
    this.db.prepare("DELETE FROM managed_settings_loaded WHERE subject=?").run(subject);
  }
}

export function settingsState(backend: SettingsBackend, saved: SettingsSnapshot, defaults: SettingsSnapshot | null,
  loaded: SettingsLoaded | null, instance: string | null): SettingsView {
  return { backend, saved, defaults, loaded, instance, issues: [], fields: Object.keys(definitions(backend)).map((key) => ({ key,
    saved: evidence(saved.values, key, `Saved settings revision ${saved.revision}`, saved.updatedAt), loaded: evidence(loaded?.values ?? null, key, "Application snapshot", loaded?.loadedAt ?? null),
    resolved: evidence(null, key, "Native configuration not observed"), effective: evidence(null, key, "Native effective value not observed"),
    pending: loaded ? !isDeepStrictEqual(saved.values[key], loaded.values[key]) : Object.hasOwn(saved.values, key),
    apply: application(key, backend), maskedBy: [] })) };
}
