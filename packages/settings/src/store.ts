import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StateJournal, stateHash, type StateApplyInput } from "@stack/api";
import { application, definitions, evidence, validateValues } from "./catalog.js";
import { settingsPatch, type SettingsBackend, type SettingsPatch, type SettingsSnapshot, type SettingsLoaded, type SettingValues, type SettingsView } from "./schema.js";

/** The owning Package API supplies its private database and lifecycle fence. */
export class SettingsStore {
  readonly maintenance: StateJournal;
  constructor(private readonly db: DatabaseSync, ownerPackage = "settings") {
    db.exec(`CREATE TABLE IF NOT EXISTS managed_settings (subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, values_json TEXT NOT NULL,
      source TEXT NOT NULL, source_revision INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_settings_receipts (request_id TEXT PRIMARY KEY, intent TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_settings_loaded (subject TEXT PRIMARY KEY, instance TEXT NOT NULL, snapshot TEXT NOT NULL);`);
    const columns = db.prepare("PRAGMA table_info(managed_settings_receipts)").all();
    if (!columns.some(row => row.name === "subject")) db.exec("ALTER TABLE managed_settings_receipts ADD COLUMN subject TEXT");
    if (!columns.some(row => row.name === "created_at")) db.exec("ALTER TABLE managed_settings_receipts ADD COLUMN created_at INTEGER");
    db.exec("CREATE TABLE IF NOT EXISTS managed_settings_retired_receipts(request_id TEXT PRIMARY KEY,intent TEXT NOT NULL,revision INTEGER NOT NULL)");
    this.maintenance = new StateJournal(db, ownerPackage);
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
      const previous = this.db.prepare("SELECT intent,revision FROM managed_settings_receipts WHERE request_id=? UNION ALL SELECT intent,revision FROM managed_settings_retired_receipts WHERE request_id=?").get(patch.requestId, patch.requestId) as { intent: string; revision: number } | undefined;
      if (previous) {
        if (previous.intent !== intent) throw new Error("requestId was reused for another settings edit");
        this.db.exec("COMMIT");
        return { requestId: patch.requestId, revision: previous.revision, duplicate: true, applied: false as const };
      }
      const plan = this.preview(subject, backend, patch);
      const revision = plan.revision + (plan.changes.length ? 1 : 0);
      if (plan.changes.length) this.db.prepare("UPDATE managed_settings SET revision=?, values_json=?, updated_at=? WHERE subject=?")
        .run(revision, JSON.stringify(plan.values), Date.now(), subject);
      this.db.prepare("INSERT INTO managed_settings_receipts(request_id,intent,revision,subject,created_at) VALUES (?,?,?,?,?)").run(patch.requestId, intent, revision, subject, Date.now());
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
  private receiptSelection(subjects: string[], cutoff: number) {
    const targets = [...new Set(subjects)].sort().map(subject => {
      const current = this.get(subject); if (!current) throw new Error("Unknown settings subject");
      return { subject, revision: current.revision, updatedAt: current.updatedAt };
    });
    const receipts = targets.flatMap(target => this.db.prepare("SELECT request_id,intent,revision,subject,created_at FROM managed_settings_receipts WHERE subject=? AND revision<? AND created_at<=? ORDER BY request_id")
      .all(target.subject, target.revision, cutoff));
    if (receipts.length > 10000) throw new Error("Settings receipt selection exceeds bound; select fewer targets");
    return { revision: stateHash([targets, receipts]), resources: receipts.map(row => String(row.request_id)), receipts };
  }
  receiptsPlan(subjects: string[], retainDays: number) {
    if (!Number.isInteger(retainDays) || retainDays < 7 || retainDays > 3650) throw new Error("Settings receipt retention must be at least seven days");
    const cutoff = Date.now() - retainDays * 86400_000, selected = this.receiptSelection(subjects, cutoff);
    return this.maintenance.plan({ subject: null, action: "settings_receipts_retire", revision: selected.revision, resources: selected.resources, blockedBy: [],
      retained: ["Current revision and receipts younger than the selected retention window remain", "Legacy receipts with unknown admission time/target remain; no fabricated age", "Minimal request IDs, intent digests and original revision tombstones permanently prevent settings-edit replay", "Saved settings, loaded selections and native/runtime effective state are unchanged"],
      regeneration: ["Future explicit settings edits create new receipts; retirement never applies settings or restarts a runtime"] }, { subjects: [...new Set(subjects)].sort(), cutoff, retainDays });
  }
  receiptsClear(input: StateApplyInput) {
    return this.maintenance.atomic(input, (plan, payload) => {
      const selection = payload as { subjects: string[]; cutoff: number; retainDays: number };
      if (plan.action !== "settings_receipts_retire" || selection.retainDays < 7 || selection.cutoff > Date.now() - 7 * 86400_000 || plan.revision !== this.receiptSelection(selection.subjects, selection.cutoff).revision)
        throw new Error("Settings receipts/current revision changed; prepare again");
    }, payload => {
      const selection = payload as { subjects: string[]; cutoff: number };
      return this.receiptSelection(selection.subjects, selection.cutoff).receipts.map(row => {
        this.db.prepare("INSERT INTO managed_settings_retired_receipts VALUES(?,?,?)").run(row.request_id!, row.intent!, row.revision!);
        this.db.prepare("DELETE FROM managed_settings_receipts WHERE request_id=?").run(row.request_id!);
        return { resource: String(row.request_id), outcome: "removed", detail: "Old active receipt retired; minimal digest/revision dedupe tombstone retained; settings and native state unchanged" };
      });
    });
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
