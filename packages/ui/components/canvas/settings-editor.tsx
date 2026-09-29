"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  boundaryTitle, buildPatch, candidateValues, conflictKeys, controlFor, describeEvidence, draftIssues, editRequest, evidenceRows, formatValue,
  inputText, isDefaultsTarget, parseInput, patchSize, sameValue, settingsKey, settleDraft,
  type Choice, type Control, type FieldDraft, type SettingsDraft, type SettingsRequest, type SettingsTarget,
} from "@/lib/stack/settings";
import type { SettingEvidence, SettingValue, SettingsCatalog, SettingsPlan, SettingsReceipt, SettingsSnapshot, SettingsView } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Time } from "./primitives";
import { useStack, useStore } from "./provider";

type Definition = SettingsCatalog["settings"][number];
type Field = SettingsView["fields"][number];

/** Watch a target's shared settings view and its catalog while an editor shows them. Reads only. */
export function useSettings(target: SettingsTarget | null, catalog: string | null) {
  const store = useStore();
  const { settingsViews, settingsCatalogs } = useStack();
  const key = target ? settingsKey(target) : null;
  // The key alone identifies the target; the object is rebuilt on every render.
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => key && targetRef.current ? store.watchSettings(targetRef.current) : undefined, [store, key]);
  useEffect(() => catalog ? store.watchSettingsCatalog(catalog) : undefined, [store, catalog]);
  return { view: key ? settingsViews[key] : undefined, catalog: catalog ? settingsCatalogs[catalog] : undefined };
}

/** Extra evidence an adapter knows about a field, such as a native feature list entry. */
export type ExtraEvidence = { label: string; text: string };

type Attempt = { requestId: string; request: SettingsRequest; draft: SettingsDraft; signature: string; baseline: number; state: "pending" | "uncertain"; error: string | null };
type Preview = { signature: string; requestId: string; plan: SettingsPlan | null; error: string | null; pending: boolean };

/**
 * One settings document: its catalog as tri-state controls, saved and observed evidence per field, and a
 * review-then-save flow. Saving is separate from application, which each adapter offers beside it.
 */
export function SettingsEditor({ target, view, viewError, catalog, choices, extraEvidence, canWrite, writeReason, onDirtyChange, groups, sectionNote }: {
  target: SettingsTarget;
  view: SettingsView | null;
  viewError: string | null;
  catalog: SettingsCatalog | null;
  /** Native choices: null when discovery cannot say, empty when it offers none. */
  choices(definition: Definition, values: Record<string, SettingValue>): Choice[] | null;
  extraEvidence?(definition: Definition): ExtraEvidence[];
  canWrite: boolean;
  writeReason?: string | null;
  onDirtyChange?(dirty: boolean): void;
  /** Catalog groups to show, in order; all by default. */
  groups?: string[];
  /** A note under each application boundary's heading. */
  sectionNote?(boundary: Field["apply"]): React.ReactNode;
}) {
  const store = useStore();
  const key = settingsKey(target);
  const defaults = isDefaultsTarget(target);
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [baseline, setBaseline] = useState<SettingsSnapshot | null>(null);
  // After our own save, the re-read at this revision is the new baseline rather than a conflict.
  const [expectRevision, setExpectRevision] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const previewSeq = useRef(0);

  const saved = view?.saved ?? null;
  const base = baseline ?? saved;
  const drafting = Object.keys(draft).length > 0;
  const built = base ? buildPatch(draft, base, preview?.requestId ?? "") : null;
  const changes = built ? patchSize(built.patch) : 0;
  const invalid = built?.invalid.length ?? 0;
  // What the review and save answer for: target, baseline revision and the minimal patch, not the request ID.
  const signature = built ? JSON.stringify([key, built.patch.expectedRevision, built.patch.set ?? {}, built.patch.reset ?? []]) : "";
  const conflict = Boolean(baseline && saved && saved.revision !== baseline.revision && expectRevision !== saved.revision);
  const conflicting = conflict && baseline && saved ? conflictKeys(baseline.values, saved.values, draft) : [];
  const issues = base ? draftIssues(base, draft) : [];
  const values = base ? candidateValues(base, draft) : {};

  // A layout effect, so a close request right after an edit already sees the edit.
  useLayoutEffect(() => { onDirtyChange?.(drafting || attempt !== null); }, [drafting, attempt, onDirtyChange]);

  // Our own save's re-read becomes the baseline for edits made while it was in flight.
  useEffect(() => {
    if (saved && expectRevision !== null && saved.revision === expectRevision) {
      setBaseline(drafting ? saved : null);
      setExpectRevision(null);
    }
  }, [saved, expectRevision, drafting]);
  // With no edits left there is nothing to fence; the next edit captures the then-current saved document.
  useEffect(() => { if (!drafting && expectRevision === null) setBaseline(null); }, [drafting, expectRevision]);

  const edit = (field: string, next: FieldDraft | null) => {
    if (!baseline && saved) setBaseline(saved);
    setDraft((current) => {
      const copy = { ...current };
      if (next) copy[field] = next; else delete copy[field];
      return copy;
    });
  };

  const discard = () => { setDraft({}); setBaseline(null); setPreview(null); setExpectRevision(null); if (attemptRef.current?.state !== "pending") { attemptRef.current = null; setAttempt(null); } };
  const rebase = () => { if (saved) setBaseline(saved); setPreview(null); setExpectRevision(null); };

  async function review() {
    if (!base || !built || invalid || !changes) return;
    const requestId = crypto.randomUUID();
    const request = editRequest(target, { ...built.patch, requestId }, "preview");
    const seq = ++previewSeq.current;
    setPreview({ signature, requestId, plan: null, error: null, pending: true });
    try {
      const plan = await store.call<SettingsPlan>(request.pkg, request.name, request.args);
      if (seq === previewSeq.current) setPreview({ signature, requestId, plan, error: null, pending: false });
    } catch (cause) {
      if (seq === previewSeq.current) setPreview({ signature, requestId, plan: null, error: cause instanceof Error ? cause.message : String(cause), pending: false });
    }
  }

  async function send(next: Attempt) {
    // Single flight per editor: a click while a save is pending cannot create a second write.
    if (attemptRef.current?.state === "pending") return;
    attemptRef.current = { ...next, state: "pending", error: null };
    setAttempt(attemptRef.current);
    try {
      const receipt = await store.call<SettingsReceipt>(next.request.pkg, next.request.name, next.request.args);
      attemptRef.current = null;
      setAttempt(null);
      setPreview(null);
      setDraft((current) => settleDraft(current, next.draft));
      setExpectRevision(receipt.revision);
      toast.success(receipt.revision === next.baseline && !receipt.duplicate ? "No saved change" : receipt.duplicate ? `Save confirmed · revision ${receipt.revision}` : `Saved · revision ${receipt.revision}`);
    } catch (cause) {
      // The outcome is unknown: keep the exact payload and request ID so a retry cannot save twice.
      attemptRef.current = { ...next, state: "uncertain", error: cause instanceof Error ? cause.message : String(cause) };
      setAttempt(attemptRef.current);
    }
  }

  function save() {
    if (!base || !built || !preview?.plan || preview.signature !== signature || conflict || !canWrite) return;
    const request = editRequest(target, { ...built.patch, requestId: preview.requestId }, "patch");
    void send({ requestId: preview.requestId, request, draft, signature, baseline: base.revision, state: "pending", error: null });
  }

  const retry = attempt?.state === "uncertain" && attempt.signature === signature ? attempt : null;
  const previewed = preview && preview.signature === signature ? preview : null;

  const definitions = catalog?.settings ?? [];
  const groupNames = groups ?? [...new Set(definitions.map((definition) => definition.group))];
  const fields = new Map((view?.fields ?? []).map((field) => [field.key, field]));
  const boundaries: Array<Field["apply"]> = [...new Set(groupNames.flatMap((group) => definitions.filter((definition) => definition.group === group).map((definition) => definition.apply)))];

  if (!view || !catalog) {
    return <p className="py-6 text-center text-xs text-muted-foreground">{viewError ? `Settings unavailable: ${viewError}` : "Reading settings…"}</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.72rem] text-muted-foreground">
        <span>Saved revision <span className="font-medium text-foreground tabular-nums">{view.saved.revision}</span> · <Time at={view.saved.updatedAt} /></span>
        {!defaults && view.loaded ? <span>Loaded revision <span className="tabular-nums">{view.loaded.revision}</span> · <Time at={view.loaded.loadedAt} /></span> : null}
        {!defaults && !view.loaded ? <span>Nothing loaded by the current runtime</span> : null}
        <span className="font-mono">{view.backend}</span>
        {viewError ? <span className="text-destructive">Last read failed: {viewError}</span> : null}
      </div>
      {view.issues.length ? <ul className="flex flex-col gap-1 text-[0.72rem] text-pretty text-muted-foreground">{view.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}

      {boundaries.map((boundary) => (
        <section key={boundary} className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5 border-b pb-1.5">
            <h3 className="text-sm font-semibold">{boundary === "voice-call" ? "Voice" : boundary === "bot-start" ? "Agent process" : "Worker selection"}</h3>
            <p className="text-[0.72rem] text-pretty text-muted-foreground">
              {defaults ? (settingsKey(target) === "bot-defaults" ? "Copied into new Bots when they are created. Existing Bots keep their own settings." : "Copied into new Workers of this provider. Existing Workers keep their own settings.")
                : boundary === "bot-start" ? "Saving never restarts the Bot. Saved values load on its next start." : boundary === "voice-call" ? "Saving never changes an active call. Saved values load on the next call." : "Saving sends no prompt. Saved values load on the next follow-up or an explicit idle application."}
            </p>
            {sectionNote?.(boundary)}
          </div>
          {groupNames.map((group) => {
            const members = definitions.filter((definition) => definition.group === group && definition.apply === boundary);
            if (!members.length) return null;
            return <Group key={group} title={group} definitions={members} fields={fields} draft={draft} base={base} values={values} target={target}
              choices={choices} extraEvidence={extraEvidence} onEdit={edit} single={groupNames.length === 1} />;
          })}
        </section>
      ))}

      {catalog.limitations.length ? (
        <details className="text-[0.72rem] text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">Limits of this contract</summary>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-pretty">{catalog.limitations.map((line) => <li key={line}>{line}</li>)}</ul>
        </details>
      ) : null}

      <div className="sticky bottom-0 -mx-1 flex flex-col gap-2 rounded-lg border bg-background/95 p-2.5 shadow-sm backdrop-blur" aria-live="polite">
        {conflict ? (
          <Alert>
            <TriangleAlertIcon />
            <AlertDescription className="flex flex-col gap-1.5">
              <span>Saved settings changed to revision {saved?.revision} while you were editing revision {baseline?.revision}.{conflicting.length ? ` Also changed there: ${conflicting.join(", ")}.` : ""}</span>
              <span className="flex flex-wrap gap-1.5">
                <Button size="xs" variant="outline" onClick={rebase}>Keep my edits on revision {saved?.revision}</Button>
                <Button size="xs" variant="ghost" onClick={discard}>Discard my edits</Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
        {issues.length ? <ul className="flex flex-col gap-0.5 text-[0.72rem] text-destructive">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
        {previewed?.plan ? <PlanSummary plan={previewed.plan} /> : null}
        {previewed?.error ? <p className="text-[0.72rem] text-destructive">Review refused: {previewed.error}</p> : null}
        {attempt?.state === "uncertain" ? (
          <p className="text-[0.72rem] text-pretty text-destructive">
            Save outcome unknown: {attempt.error}. {retry ? "Retrying sends the identical edit with the same request ID, so it cannot save twice." : "The draft changed since, so that attempt cannot be retried; review the current draft instead."}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-[0.72rem] text-muted-foreground">
            {attempt?.state === "pending" ? "Saving…" : changes ? `${changes} change${changes === 1 ? "" : "s"} not saved` : drafting ? "No change from saved" : "No unsaved changes"}
            {!canWrite && writeReason ? ` · ${writeReason}` : ""}
          </span>
          <Button size="sm" variant="ghost" disabled={!drafting || attempt?.state === "pending"} onClick={discard}>Discard</Button>
          {retry ? (
            <Button size="sm" disabled={!canWrite} onClick={() => void send(retry)}>Retry same save</Button>
          ) : previewed?.plan && !previewed.error ? (
            <Button size="sm" disabled={!canWrite || conflict || attempt?.state === "pending" || issues.length > 0} title={!canWrite ? writeReason ?? undefined : undefined} onClick={save}>
              {attempt?.state === "pending" ? <Spinner data-icon="inline-start" /> : null}Save {changes} change{changes === 1 ? "" : "s"}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={!changes || invalid > 0 || conflict || preview?.pending === true || attempt?.state === "pending"} onClick={() => void review()}>
              {preview?.pending && preview.signature === signature ? <Spinner data-icon="inline-start" /> : null}Review changes
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A preview's changes, reading presence before value so a reset and a saved null stay distinct. */
function PlanSummary({ plan }: { plan: SettingsPlan }) {
  const side = (set: boolean, value: SettingValue) => set ? formatValue(value) : "Unset";
  return (
    <div className="flex flex-col gap-1 text-[0.72rem]">
      {plan.changes.length ? (
        <ul className="flex flex-col gap-0.5">
          {plan.changes.map((change) => (
            <li key={change.key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="font-mono">{change.key}</span>
              <span className="min-w-0 truncate text-muted-foreground">{side(change.beforeSet, change.before)}</span>
              <span aria-hidden className="text-muted-foreground">→</span>
              <span className="sr-only">becomes</span>
              <span className="min-w-0 truncate font-medium">{side(change.afterSet, change.after)}</span>
              <span className="text-muted-foreground">· {boundaryTitle[change.apply as Field["apply"]] ?? change.apply}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-muted-foreground">The saved document would not change.</p>}
      {plan.issues.length ? <ul className="flex flex-col gap-0.5 text-pretty text-muted-foreground">{plan.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
    </div>
  );
}

function Group({ title, definitions, fields, draft, base, values, target, choices, extraEvidence, onEdit, single }: {
  title: string;
  definitions: Definition[];
  fields: Map<string, Field>;
  draft: SettingsDraft;
  base: SettingsSnapshot | null;
  values: Record<string, SettingValue>;
  target: SettingsTarget;
  choices(definition: Definition, values: Record<string, SettingValue>): Choice[] | null;
  extraEvidence?(definition: Definition): ExtraEvidence[];
  onEdit(key: string, next: FieldDraft | null): void;
  single: boolean;
}) {
  const set = definitions.filter((definition) => base && Object.hasOwn(base.values, definition.key)).length;
  const edited = definitions.filter((definition) => draft[definition.key]).length;
  const pending = definitions.filter((definition) => fields.get(definition.key)?.pending).length;
  const [open, setOpen] = useState(single || edited > 0);
  const summary = [set ? `${set} set` : "all unset", edited ? `${edited} edited` : null, pending && !isDefaultsTarget(target) ? `${pending} pending` : null].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col">
      {single ? null : (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
          className="-mx-1 flex items-center gap-1 rounded-md px-1 py-1 text-left text-[0.78rem] font-medium hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          {title}
          <span className="ml-auto text-[0.7rem] font-normal text-muted-foreground">{summary}</span>
        </button>
      )}
      {open ? (
        <div className="flex flex-col divide-y divide-border/60">
          {definitions.map((definition) => (
            <FieldRow key={definition.key} definition={definition} field={fields.get(definition.key)} draft={draft[definition.key]} base={base}
              target={target} choices={choices(definition, values)} extra={extraEvidence?.(definition) ?? []} onEdit={(next) => onEdit(definition.key, next)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FieldRow({ definition, field, draft, base, target, choices, extra, onEdit }: {
  definition: Definition;
  field: Field | undefined;
  draft: FieldDraft | undefined;
  base: SettingsSnapshot | null;
  target: SettingsTarget;
  choices: Choice[] | null;
  extra: ExtraEvidence[];
  onEdit(next: FieldDraft | null): void;
}) {
  const id = useId();
  const control = useMemo(() => controlFor(definition.schema), [definition.schema]);
  const savedSet = Boolean(base && Object.hasOwn(base.values, definition.key));
  const savedValue = savedSet ? base!.values[definition.key] : undefined;
  const changed = draft ? draft.kind === "invalid" || (draft.kind === "reset" ? savedSet : !savedSet || !sameValue(savedValue, draft.value)) : false;
  const defaults = isDefaultsTarget(target);
  const rows = evidenceRows(target, field, definition);
  return (
    <div role="group" aria-labelledby={`${id}-title`} className={cn("flex flex-col gap-2 py-2.5", changed && "-mx-2 rounded-md bg-primary/5 px-2")}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span id={`${id}-title`} className="text-[0.8rem] font-medium">{definition.title}</span>
        <span className="font-mono text-[0.66rem] text-muted-foreground">{definition.key}</span>
        {definition.stability === "experimental" ? <Tag>experimental</Tag> : null}
        {changed ? <Tag tone="primary">edited</Tag> : null}
        {!defaults && field?.pending ? <Tag tone="warning" title="Saved differs from what the current runtime loaded at its last boundary. This does not prove a mismatch or a failure.">pending · {boundaryTitle[field.apply].toLowerCase()}</Tag> : null}
        {field?.maskedBy.length ? <Tag tone="warning" title={field.maskedBy.join("; ")}>may be masked</Tag> : null}
        {draft ? (
          <button type="button" onClick={() => onEdit(null)} className="ml-auto inline-flex items-center gap-1 rounded text-[0.7rem] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <RotateCcwIcon aria-hidden className="size-3" />Undo edit
          </button>
        ) : null}
      </div>
      <p className="text-[0.72rem] text-pretty text-muted-foreground">{definition.description}{definition.dependencies.length ? ` Related: ${definition.dependencies.join(", ")}.` : ""}</p>
      <FieldControl id={id} title={definition.title} control={control} savedSet={savedSet} savedValue={savedValue} draft={draft} choices={choices} onEdit={onEdit} />
      {draft?.kind === "invalid" ? <p className="text-[0.72rem] text-destructive">{draft.error}</p> : null}
      {definition.key === "voice.prompt" ? <p className="text-[0.68rem] text-muted-foreground">Unset omits the field. Clear saves an explicit native null. Set with empty text saves an intentional empty prompt.</p> : null}
      {target.kind === "worker" && (definition.key === "model" || definition.key === "effort") ? <p className="text-[0.68rem] text-muted-foreground">Unset removes the saved override; the current session keeps its native selection.</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[0.7rem] sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Evidence label="Saved" evidence={field?.saved ?? { state: savedSet ? "known" : "native", value: savedValue ?? null, source: "Saved", observedAt: null }} unset="Unset" />
        {rows.map((row) => <Evidence key={row.label} label={row.label} evidence={row.evidence} unset={row.unset} unknown={row.unknown} />)}
        {extra.map((row) => <div key={row.label} className="contents"><dt className="text-muted-foreground">{row.label}</dt><dd className="min-w-0 truncate">{row.text}</dd></div>)}
        {field?.maskedBy.length ? <div className="contents"><dt className="text-muted-foreground">Masking hints</dt><dd className="min-w-0 text-pretty text-warning">{field.maskedBy.join("; ")}</dd></div> : null}
      </dl>
    </div>
  );
}

function Evidence({ label, evidence, unset, unknown }: { label: string; evidence: SettingEvidence; unset: string; unknown?: string }) {
  const { text, state } = describeEvidence(evidence, unset, unknown);
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate", state === "known" ? "font-mono text-foreground" : "text-muted-foreground italic")} title={`${evidence.source}${evidence.observedAt ? ` · ${new Date(evidence.observedAt).toLocaleString()}` : ""}`}>
        {text}
      </dd>
    </div>
  );
}

function Tag({ children, tone, title }: { children: React.ReactNode; tone?: "primary" | "warning"; title?: string }) {
  return (
    <span title={title} className={cn("rounded px-1 py-px text-[0.64rem] font-medium", tone === "primary" ? "bg-primary/10 text-primary" : tone === "warning" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground")}>
      {children}
    </span>
  );
}

const custom = "\u0000custom";

/**
 * The tri-state editor for one value. Unset and explicit values are separate choices, so omission is never
 * an empty input; a value discovery no longer offers stays selected and labelled.
 */
function FieldControl({ id, title, control, savedSet, savedValue, draft, choices, onEdit }: {
  id: string;
  title: string;
  control: Control;
  savedSet: boolean;
  savedValue: SettingValue | undefined;
  draft: FieldDraft | undefined;
  choices: Choice[] | null;
  onEdit(next: FieldDraft | null): void;
}) {
  // What the control shows: the draft, else the saved value.
  const shown: { mode: "unset" | "set" | "null"; value: SettingValue | undefined; raw: string | null } =
    draft?.kind === "reset" ? { mode: "unset", value: undefined, raw: null }
      : draft?.kind === "invalid" ? { mode: "set", value: undefined, raw: draft.raw }
      : draft?.kind === "set" ? { mode: draft.value === null && control.kind === "string" && control.nullable ? "null" : "set", value: draft.value, raw: null }
      : savedSet ? { mode: savedValue === null && control.kind === "string" && control.nullable ? "null" : "set", value: savedValue, raw: null }
      : { mode: "unset", value: undefined, raw: null };
  const [customOpen, setCustomOpen] = useState(false);
  // Choosing a state equal to the saved one clears the edit instead of recording a no-op.
  const choose = (next: FieldDraft) => {
    if (next.kind === "reset" && !savedSet) return onEdit(null);
    if (next.kind === "set" && savedSet && sameValue(savedValue, next.value)) return onEdit(null);
    onEdit(next);
  };

  if (control.kind === "boolean") {
    const current = shown.mode === "unset" ? "unset" : shown.value === true ? "true" : shown.value === false ? "false" : "unset";
    return <Segments name={`${id}-value`} label={title} value={current}
      options={[["unset", "Unset"], ["true", "On"], ["false", "Off"]]}
      onChange={(value) => choose(value === "unset" ? { kind: "reset" } : { kind: "set", value: value === "true" })} />;
  }

  const modes: Array<[string, string]> = [["unset", "Unset"], ["set", "Set"]];
  if (control.kind === "string" && control.nullable) modes.push(["null", "Clear (null)"]);
  const startSet = (): FieldDraft => {
    if (savedSet && savedValue !== null) return { kind: "set", value: savedValue! };
    if (control.kind === "enum" || choices?.length) return { kind: "invalid", raw: "", error: "Choose a value or Unset." };
    return parseInput(control, "");
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Segments name={`${id}-mode`} label={`${title} state`} value={shown.mode} options={modes}
        onChange={(mode) => choose(mode === "unset" ? { kind: "reset" } : mode === "null" ? { kind: "set", value: null } : startSet())} />
      {shown.mode === "set" ? (
        <ValueInput title={title} control={control} value={shown.value} raw={shown.raw} savedValue={savedValue} choices={choices}
          customOpen={customOpen} setCustomOpen={setCustomOpen} onDraft={choose} />
      ) : null}
    </div>
  );
}

function ValueInput({ title, control, value, raw, savedValue, choices, customOpen, setCustomOpen, onDraft }: {
  title: string;
  control: Control;
  value: SettingValue | undefined;
  raw: string | null;
  savedValue: SettingValue | undefined;
  choices: Choice[] | null;
  customOpen: boolean;
  setCustomOpen(value: boolean): void;
  onDraft(next: FieldDraft): void;
}) {
  const text = raw ?? inputText(value);
  const label = `${title} value`;
  if (control.kind === "enum") {
    const known = typeof value === "string" && control.values.includes(value);
    return (
      <NativeSelect size="sm" aria-label={label} className="w-full max-w-72" value={typeof value === "string" ? value : ""}
        onChange={(event) => event.target.value ? onDraft({ kind: "set", value: event.target.value }) : undefined}>
        {typeof value !== "string" ? <NativeSelectOption value="">Choose…</NativeSelectOption> : null}
        {typeof value === "string" && !known ? <NativeSelectOption value={value}>{value} (not in catalog)</NativeSelectOption> : null}
        {control.values.map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}
      </NativeSelect>
    );
  }
  if (control.kind === "string" && choices?.length && !control.multiline) {
    const current = typeof value === "string" ? value : "";
    const offered = choices.some((choice) => choice.value === current);
    const savedMissing = typeof savedValue === "string" && !choices.some((choice) => choice.value === savedValue);
    const selecting = !customOpen && (offered || !current || current === savedValue);
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {selecting ? (
          <NativeSelect size="sm" aria-label={label} className="w-full max-w-72" value={current}
            onChange={(event) => {
              if (event.target.value === custom) { setCustomOpen(true); return; }
              if (event.target.value) onDraft({ kind: "set", value: event.target.value });
            }}>
            {!current ? <NativeSelectOption value="">Choose…</NativeSelectOption> : null}
            {savedMissing ? <NativeSelectOption value={savedValue as string}>{savedValue as string} (saved, not offered now)</NativeSelectOption> : null}
            {current && !offered && current !== savedValue ? <NativeSelectOption value={current}>{current} (not offered)</NativeSelectOption> : null}
            <NativeSelectOptGroup label="Offered by native discovery">
              {choices.map((choice) => <NativeSelectOption key={choice.value} value={choice.value}>{choice.label}{choice.label !== choice.value ? ` · ${choice.value}` : ""}{choice.detail ? ` (${choice.detail})` : ""}</NativeSelectOption>)}
            </NativeSelectOptGroup>
            <NativeSelectOption value={custom}>Other identifier…</NativeSelectOption>
          </NativeSelect>
        ) : (
          <>
            <Input aria-label={label} className="h-7 w-full max-w-72 font-mono text-xs" value={text} spellCheck={false} autoComplete="off"
              onChange={(event) => onDraft(parseInput(control, event.target.value))} />
            <Button size="xs" variant="ghost" onClick={() => setCustomOpen(false)}>Offered choices</Button>
          </>
        )}
        {current && !offered ? <span className="text-[0.68rem] text-muted-foreground">Not offered by current discovery; kept as entered.</span> : null}
      </div>
    );
  }
  if (control.kind === "string" && control.multiline) {
    return <Textarea aria-label={label} className="max-h-72 min-h-16 font-mono text-xs" value={text} spellCheck={false}
      placeholder={value === "" ? "Empty string (saved as \"\")" : undefined} onChange={(event) => onDraft(parseInput(control, event.target.value))} />;
  }
  if (control.kind === "list") {
    return (
      <div className="flex flex-col gap-1">
        <Textarea aria-label={label} className="min-h-14 font-mono text-xs" value={text} spellCheck={false} placeholder="One entry per line; empty saves []"
          onChange={(event) => onDraft(parseInput(control, event.target.value))} />
        {Array.isArray(value) && !value.length ? <span className="text-[0.68rem] text-muted-foreground">Explicit empty list</span> : null}
      </div>
    );
  }
  if (control.kind === "unknown") return <p className="text-[0.72rem] text-muted-foreground">No editor for this value type: {formatValue(value ?? null)}</p>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Input aria-label={label} className="h-7 w-full max-w-72 font-mono text-xs" value={text} spellCheck={false} autoComplete="off"
        inputMode={control.kind === "number" ? "numeric" : undefined}
        onChange={(event) => onDraft(parseInput(control, event.target.value))} />
      {choices && typeof value === "string" && value && !choices.some((choice) => choice.value === value)
        ? <span className="text-[0.68rem] text-muted-foreground">{choices.length ? "Not offered by current discovery; kept as entered." : "Current discovery offers no choices here; kept as entered."}</span> : null}
    </div>
  );
}

/** Native radios styled as one segmented control, so every state is a labelled, keyboard-reachable choice. */
function Segments({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: Array<[string, string]>; onChange(value: string): void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map(([option, title]) => (
        <label key={option}
          className="relative cursor-pointer rounded-md px-2 py-0.5 text-center text-[0.72rem] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground has-checked:bg-background has-checked:font-medium has-checked:text-foreground has-checked:shadow-xs has-focus-visible:outline-2 has-focus-visible:outline-ring has-disabled:pointer-events-none has-disabled:opacity-50">
          <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} className="absolute inset-0 cursor-pointer appearance-none rounded-md opacity-0" />
          {title}
        </label>
      ))}
    </div>
  );
}
