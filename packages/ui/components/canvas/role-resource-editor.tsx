"use client";

import { useId, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  FileCodeIcon,
  FileIcon,
  FilePlusIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  addedIds,
  approxTokens,
  base64Bytes,
  blankMcpText,
  blankProjectText,
  blankSkillText,
  decodeBase64,
  descriptionLimit,
  draftChanges,
  draftConflicts,
  draftFiles,
  draftMcpForm,
  encodeBase64,
  fileText,
  findResource,
  formatBytes,
  formatCount,
  fromMcpForm,
  internalCollision,
  internalNames,
  keepDraft,
  mcpLiterals,
  mcpText,
  mcpToml,
  nameIssue,
  projectBots,
  projectText,
  resourceNameLimit,
  safeFilePath,
  skillBodyLimit,
  skillFileBytesLimit,
  skillFileCountLimit,
  skillFileIssues,
  skillText,
  splitCommandLine,
  textFile,
  uniqueName,
  utf8Bytes,
  yieldDraft,
  type McpForm,
  type ResourceKind,
} from "@/lib/stack/roles";
import type { RoleMcpServer, RoleSkill, RoleSkillFile, RoleSnapshot, RoleTrustedProject } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { BotTile, NodeLink } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { resourceOperation, useRoleActions } from "./role-actions";
import { ConflictNotice, EditorFrame, Gone, hintClass, labelClass, RecordMenu, SaveBar, saveKeys, useDraft, useFocusField } from "./role-editor-parts";

type Fields = Record<string, string>;

/** How one resource kind reads from the Role and turns draft text back into operation arguments. */
type Spec<T extends { id: string; enabled: boolean }> = {
  kind: ResourceKind;
  noun: string;
  list(role: RoleSnapshot | null): T[] | undefined;
  text(item: T): Fields;
  blank: Fields;
  args(fields: Fields): Record<string, unknown>;
};

const skillSpec: Spec<RoleSkill> = {
  kind: "skill", noun: "skill", list: (role) => role?.skills, text: skillText, blank: blankSkillText,
  args: ({ files, harnesses, ...fields }) => ({ ...fields, ...(files !== undefined ? { files: draftFiles(files) } : {}),
    ...(harnesses !== undefined ? { harnesses: JSON.parse(harnesses) } : {}) }),
};
const mcpSpec: Spec<RoleMcpServer> = {
  kind: "mcp-server", noun: "MCP server", list: (role) => role?.mcpServers, text: mcpText, blank: blankMcpText,
  args: ({ definition, harnesses, ...fields }) => ({ ...fields, ...(definition !== undefined ? { definition: fromMcpForm(draftMcpForm(definition)).definition } : {}),
    ...(harnesses !== undefined ? { harnesses: JSON.parse(harnesses) } : {}) }),
};
const projectSpec: Spec<RoleTrustedProject> = {
  kind: "trusted-project", noun: "trusted project", list: (role) => role?.trustedProjects, text: projectText, blank: blankProjectText,
  args: (fields) => fields,
};

/** A saved record's draft, save, enable switch and hand-back once it disappears. */
function useSaved<T extends { id: string; enabled: boolean }>(spec: Spec<T>, id: string) {
  const { role, status } = useStack();
  const actions = useRoleActions();
  const found = findResource(spec.list(role.data), id);
  const lastSeen = useRef<T | null>(null);
  if (found) lastSeen.current = found.item;
  const key = `${spec.kind}:${id}`;
  const saved = found ? spec.text(found.item) : lastSeen.current ? spec.text(lastSeen.current) : spec.blank;
  const draft = useDraft(key, saved);
  const [error, setError] = useState<string | null>(null);
  const connected = status.roles === "open";
  const saving = actions.pending.has(`save:${key}`);
  const operation = resourceOperation[spec.kind];
  const dirty = Object.keys(draft.changes).length > 0;
  const gone = `This ${spec.noun} was deleted elsewhere.`;
  return {
    found, saved, draft, error, connected, saving, dirty,
    save(invalid: string | null) {
      if (!dirty || invalid || draft.conflicts.length || saving || !connected) return;
      const pendingDraft = draft.draft;
      setError(null);
      actions.write(`${operation}_update`, (snapshot) => {
        const current = findResource(spec.list(snapshot), id)?.item;
        if (!current) return gone;
        if (draftConflicts(pendingDraft, spec.text(current)).length) return "It changed elsewhere while saving. Choose which version to keep.";
        return { id, ...spec.args(draftChanges(pendingDraft, spec.text(current))) };
      }, `save:${key}`).then(() => draft.clear(), (cause) => setError(errorMessage(cause)));
    },
    revert() { draft.clear(); setError(null); },
    setEnabled(enabled: boolean) {
      actions.act(`${operation}_update`, (snapshot) => findResource(spec.list(snapshot), id) ? { id, enabled } : gone, `enable:${id}`);
    },
    enabling: actions.pending.has(`enable:${id}`),
    restore() {
      actions.setDraft(`new-${spec.kind}`, { base: {}, values: { ...saved, ...draft.draft.values } });
      actions.setDraft(key, null);
      actions.open({ kind: `new-${spec.kind}`, enabled: lastSeen.current?.enabled ?? true });
    },
    keep() { draft.replace(keepDraft(draft.draft, saved)); },
    yield() { draft.replace(yieldDraft(draft.draft, saved)); },
  };
}

/** A new record's draft and create; the editor then opens what was created. */
function useCreate<T extends { id: string; enabled: boolean }>(spec: Spec<T>, enabled: boolean) {
  const { role, status } = useStack();
  const actions = useRoleActions();
  const key = `new-${spec.kind}`;
  const draft = useDraft(key, spec.blank);
  const [error, setError] = useState<string | null>(null);
  const connected = status.roles === "open";
  const creating = actions.pending.has(`save:${key}`);
  const operation = resourceOperation[spec.kind];
  return {
    draft, error, connected, creating,
    create(invalid: string | null) {
      if (invalid || creating || !connected) return;
      const fields = { ...spec.blank, ...draft.draft.values };
      const before = spec.list(role.data) ?? [];
      setError(null);
      actions.write(`${operation}_create`, () => ({ ...spec.args(fields), enabled }), `save:${key}`).then((snapshot) => {
        draft.clear();
        const created = addedIds(before, spec.list(snapshot) ?? [])[0];
        actions.open(created ? { kind: spec.kind, id: created } : null);
      }, (cause) => setError(errorMessage(cause)));
    },
    cancel() { draft.clear(); actions.open(null); },
    setEnabled(next: boolean) { actions.open({ kind: `new-${spec.kind}`, enabled: next }); },
  };
}

/** Duplicate a skill or MCP server under the next free name, carrying any unsaved edits. */
function useDuplicate<T extends { id: string; enabled: boolean; name: string; harnesses?: RoleSkill["harnesses"] }>(spec: Spec<T>, id: string, edits: Fields) {
  const { role } = useStack();
  const actions = useRoleActions();
  return () => actions.write(`${resourceOperation[spec.kind]}_create`, (snapshot) => {
    const items = spec.list(snapshot) ?? [];
    const current = findResource(items, id)?.item;
    if (!current) return `This ${spec.noun} was deleted elsewhere.`;
    const fields = { ...spec.text(current), ...edits };
    return { ...spec.args(fields), name: uniqueName(fields.name || current.name, items.map((item) => item.name)), enabled: current.enabled, harnesses: current.harnesses };
  }, `duplicate:${id}`).then((snapshot) => {
    const created = addedIds(spec.list(role.data) ?? [], spec.list(snapshot) ?? [])[0];
    if (created) actions.open({ kind: spec.kind, id: created });
  }, (cause) => toast.error(errorMessage(cause)));
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p role="alert" className="px-0.5 text-[0.72rem] text-pretty text-destructive">{error}</p> : null;
}

function Issues({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  return (
    <ul className="flex flex-col gap-0.5 px-0.5 text-[0.68rem] text-destructive" aria-label="Problems to fix before saving">
      {issues.map((issue) => <li key={issue} className="text-pretty">{issue}</li>)}
    </ul>
  );
}

function EnabledRow({ id, checked, disabled, onChange, note, children }: {
  id: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void; note: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-background/50 px-3 py-2">
      <div className="flex items-center gap-3">
        <Switch id={`${id}-enabled`} size="sm" checked={checked} disabled={disabled} onCheckedChange={onChange} />
        <label htmlFor={`${id}-enabled`} className="text-[0.78rem]">
          Enabled<span className="ml-1.5 text-[0.68rem] text-muted-foreground">{note}</span>
        </label>
      </div>
      {children}
    </div>
  );
}

function NameField({ id, value, onChange, issue, hint }: { id: string; value: string; onChange(value: string): void; issue: string | null; hint: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-name`} className={labelClass}>Name</label>
      <Input id={`${id}-name`} value={value} maxLength={resourceNameLimit} spellCheck={false} autoComplete="off" placeholder="lowercase-name"
        aria-invalid={issue ? true : undefined} aria-describedby={`${id}-name-hint`}
        onChange={(event) => onChange(event.target.value.toLowerCase().replace(/[\s_]+/g, "-"))} className="h-8 font-mono text-[0.8rem] md:text-[0.8rem]" />
      <p id={`${id}-name-hint`} className={cn(hintClass, issue && value && "text-destructive")}>{issue && value ? issue : hint}</p>
    </div>
  );
}

function DescriptionField({ id, value, onChange, required, hint, placeholder }: {
  id: string; value: string; onChange(value: string): void; required?: boolean; hint: string; placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-description`} className={labelClass}>Description{required ? null : <span className="font-normal"> · optional</span>}</label>
      <Textarea id={`${id}-description`} value={value} maxLength={descriptionLimit} rows={2} placeholder={placeholder} aria-describedby={`${id}-description-hint`}
        aria-invalid={required && !value.trim() ? true : undefined}
        onChange={(event) => onChange(event.target.value)} className="max-h-32 min-h-12 resize-none text-[0.8rem] md:text-[0.8rem]" />
      <p id={`${id}-description-hint`} className={hintClass}>{hint}</p>
    </div>
  );
}

/* ─── Skills ─────────────────────────────────────────────────────────── */

/** What blocks saving a skill: the name, then other fields; supporting-file problems show beside the files. */
function skillProblems(value: (field: string) => string, others: string[]) {
  const nameProblem = nameIssue(value("name"), others);
  const other = [
    ...(!value("description").trim() ? ["A description is required: Bots read it to decide when to use the skill"] : []),
    ...(value("body").length > skillBodyLimit ? [`The body is longer than ${skillBodyLimit.toLocaleString()} characters`] : []),
  ];
  return { nameProblem, other, invalid: nameProblem ?? other[0] ?? skillFileIssues(draftFiles(value("files")))[0] ?? null };
}

function SkillFields({ id, value, set, nameProblem }: { id: string; value(field: string): string; set(field: string, value: string): void; nameProblem: string | null }) {
  const bytes = utf8Bytes(value("body"));
  const name = value("name") || "name";
  return (
    <>
      <NameField id={id} value={value("name")} onChange={(next) => set("name", next)} issue={nameProblem}
        hint={`Each launch writes it as skills/${name}/SKILL.md. Lowercase letters, digits and hyphens.`} />
      <DescriptionField id={id} value={value("description")} onChange={(next) => set("description", next)} required
        placeholder="When a Bot should use this skill" hint="Bots see this. It becomes the SKILL.md description Bots use to decide when to load the skill." />
      <div className="flex min-h-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`${id}-body`} className={labelClass}>SKILL.md body</label>
          <span className="text-[0.65rem] text-muted-foreground tabular-nums">{formatBytes(bytes)} · ≈{formatCount(approxTokens(bytes))} tokens</span>
        </div>
        <pre aria-label="Generated SKILL.md header" className="rounded-t-lg border border-b-0 bg-muted/40 px-2.5 py-1.5 font-mono text-[0.68rem] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(value("description").split("\n")[0].slice(0, 80) + (value("description").length > 80 ? "…" : ""))}\n---`}
        </pre>
        <Textarea id={`${id}-body`} value={value("body")} spellCheck={false} aria-describedby={`${id}-body-hint`}
          placeholder="# Skill&#10;&#10;What to do, step by step, and which supporting files to use."
          onChange={(event) => set("body", event.target.value)}
          className="-mt-1.5 min-h-56 resize-y rounded-t-none font-mono text-[0.78rem] leading-relaxed md:text-[0.78rem]" />
        <p id={`${id}-body-hint`} className={hintClass}>Markdown after the generated header. Supporting files sit beside SKILL.md.</p>
      </div>
      <SkillFiles files={draftFiles(value("files"))} onChange={(files) => set("files", JSON.stringify(files))} />
    </>
  );
}

function nextPath(path: string, taken: RoleSkillFile[]): string {
  const used = new Set(taken.map((file) => file.path.toLowerCase()));
  if (!used.has(path.toLowerCase())) return path;
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let attempt = 2; ; attempt++) if (!used.has(`${stem}-${attempt}${ext}`.toLowerCase())) return `${stem}-${attempt}${ext}`;
}

/** Supporting files are one draft field: the API replaces the whole set on each save. */
function SkillFiles({ files, onChange }: { files: RoleSkillFile[]; onChange(files: RoleSkillFile[]): void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const total = files.reduce((sum, file) => sum + base64Bytes(file.contentBase64), 0);
  const issues = skillFileIssues(files);

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    let next = [...files];
    for (const file of Array.from(list)) {
      if (file.size > skillFileBytesLimit) { toast.error(`${file.name} is larger than ${formatBytes(skillFileBytesLimit)}`); continue; }
      next = [...next, { path: nextPath(safeFilePath(file.name), next), contentBase64: encodeBase64(new Uint8Array(await file.arrayBuffer())) }];
    }
    onChange(next);
  };
  const update = (index: number, file: RoleSkillFile) => onChange(files.map((item, at) => at === index ? file : item));
  const remove = (index: number) => { onChange(files.filter((_, at) => at !== index)); setEditing(null); };
  const download = (file: RoleSkillFile) => {
    const url = URL.createObjectURL(new Blob([decodeBase64(file.contentBase64).slice().buffer]));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.path.split("/").pop() ?? "file";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section aria-label="Supporting files"
      onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.stopPropagation(); setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); setDropping(false); void add(event.dataTransfer.files); }}
      className={cn("flex flex-col gap-1.5 rounded-xl border border-transparent transition-colors", dropping && "border-dashed border-pkg-roles/60 bg-pkg-roles/5")}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={labelClass}>Supporting files</h3>
        <span className="text-[0.65rem] text-muted-foreground tabular-nums">{files.length} of {skillFileCountLimit} · {formatBytes(total)}</span>
      </div>
      {files.length ? (
        <ol className="flex flex-col rounded-xl border bg-background/50 p-1">
          {files.map((file, index) => {
            const text = fileText(file);
            const open = editing === index && text !== null;
            return (
              <li key={index} className="flex flex-col gap-1 rounded-lg px-1.5 py-1 hover:bg-muted/50">
                <div className="flex items-center gap-1.5">
                  {text !== null ? <FileCodeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                  <Input aria-label={`Path of ${file.path || "file"}`} value={file.path} spellCheck={false} maxLength={240}
                    onChange={(event) => update(index, { ...file, path: event.target.value })}
                    className="h-6 min-w-0 flex-1 border-transparent bg-transparent px-1 font-mono text-[0.72rem] shadow-none hover:border-input focus-visible:border-input md:text-[0.72rem] dark:bg-transparent" />
                  <span className="shrink-0 text-[0.64rem] text-muted-foreground tabular-nums">{text === null ? "binary · " : ""}{formatBytes(base64Bytes(file.contentBase64))}</span>
                  {text !== null ? (
                    <Button size="icon-xs" variant="ghost" aria-label={open ? `Close ${file.path}` : `Edit ${file.path}`} aria-expanded={open} onClick={() => setEditing(open ? null : index)}>
                      {open ? <XIcon /> : <PencilIcon />}
                    </Button>
                  ) : null}
                  <Button size="icon-xs" variant="ghost" aria-label={`Download ${file.path}`} onClick={() => download(file)}><DownloadIcon /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Remove ${file.path}`} className="hover:text-destructive" onClick={() => remove(index)}><XIcon /></Button>
                </div>
                {open ? (
                  <Textarea aria-label={`Contents of ${file.path}`} value={text} spellCheck={false}
                    onChange={(event) => update(index, textFile(file.path, event.target.value))}
                    className="min-h-32 resize-y font-mono text-[0.74rem] leading-relaxed md:text-[0.74rem]" />
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : <p className={hintClass}>Scripts, templates or references the skill points to. Drop files here or add them below.</p>}
      <Issues issues={issues} />
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" variant="outline" onClick={() => { const next = [...files, textFile(nextPath("notes.md", files), "")]; onChange(next); setEditing(next.length - 1); }}>
          <FilePlusIcon data-icon="inline-start" />New text file
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => input.current?.click()}><UploadIcon data-icon="inline-start" />Upload</Button>
        <input ref={input} type="file" multiple hidden onChange={(event) => { void add(event.target.files); event.target.value = ""; }} />
      </div>
    </section>
  );
}

export function SkillEditor({ id }: { id: string }) {
  const { role } = useStack();
  const actions = useRoleActions();
  const { select } = useWorkbench();
  const formId = useId();
  const saved = useSaved(skillSpec, id);
  const duplicate = useDuplicate(skillSpec, id, saved.draft.draft.values);
  if (!saved.found) return <Gone noun="skill" draft={saved.draft.draft} onRestore={saved.restore} />;
  const skill = saved.found.item;
  const others = (role.data?.skills ?? []).filter((item) => item.id !== id).map((item) => item.name);
  const { nameProblem, other, invalid } = skillProblems(saved.draft.value, others);
  const save = () => saved.save(invalid);
  return (
    <EditorFrame subtitle="skill"
      footer={<SaveBar dirty={saved.dirty} conflicts={saved.draft.conflicts.length} pending={saved.saving} invalid={invalid} saveLabel="Save" onSave={save} onRevert={saved.revert} />}
      actions={<RecordMenu label={skill.name} onInspect={() => select({ kind: "skill", id })} onDuplicate={duplicate} onDelete={() => actions.confirmDelete({ kind: "skill", id })} />}>
      <form className="flex flex-col gap-3" aria-label={`Edit skill ${skill.name}`} onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={saveKeys(save)}>
        <ConflictNotice fields={saved.draft.conflicts} onKeep={saved.keep} onYield={saved.yield} />
        <EnabledRow id={formId} checked={skill.enabled} disabled={!saved.connected || saved.enabling} onChange={saved.setEnabled}
          note={skill.enabled ? "Included in new launches where its harness filter allows" : "Skipped in new launches"} />
        <SkillFields id={formId} value={saved.draft.value} set={saved.draft.set} nameProblem={nameProblem} />
        <Issues issues={other} />
        <ErrorText error={saved.error} />
      </form>
    </EditorFrame>
  );
}

export function NewSkillEditor({ enabled }: { enabled: boolean }) {
  const { role } = useStack();
  const formId = useId();
  const created = useCreate(skillSpec, enabled);
  useFocusField(formId, "name");
  const { nameProblem, other, invalid } = skillProblems(created.draft.value, (role.data?.skills ?? []).map((item) => item.name));
  const create = () => created.create(invalid);
  return (
    <EditorFrame subtitle="new skill"
      footer={<SaveBar dirty={created.connected} conflicts={0} pending={created.creating} invalid={invalid} saveLabel="Create skill" onSave={create} note="Not created yet" />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Discard new skill" onClick={created.cancel}><XIcon /></Button>}>
      <form className="flex flex-col gap-3" aria-label="New skill" onSubmit={(event) => { event.preventDefault(); create(); }} onKeyDown={saveKeys(create)}>
        <EnabledRow id={formId} checked={enabled} onChange={created.setEnabled} note={enabled ? "Included where its harness filter allows once created" : "Created switched off"} />
        <SkillFields id={formId} value={created.draft.value} set={created.draft.set} nameProblem={nameProblem} />
        <Issues issues={other} />
        <ErrorText error={created.error} />
        <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={created.cancel}>Discard</Button>
      </form>
    </EditorFrame>
  );
}

/* ─── MCP servers ────────────────────────────────────────────────────── */

/**
 * What blocks saving a server: its name, including a clash with a default Stack MCP server, then its
 * connection. `internal` is every internal name, switched off or not: turning a built-in off frees nothing.
 */
function mcpProblems(value: (field: string) => string, others: string[], internal: string[]) {
  const name = value("name");
  const nameProblem = nameIssue(name, others) ?? (internalCollision(name, internal) ? "A Stack server already uses this name, even while it is switched off" : null);
  const { issues } = fromMcpForm(draftMcpForm(value("definition")));
  return { nameProblem, issues, invalid: nameProblem ?? issues[0] ?? null };
}

function Pairs({ label, rows, onChange, keyLabel, valueLabel, keyPlaceholder, valuePlaceholder, secret }: {
  label: string; rows: Array<[string, string]>; onChange(rows: Array<[string, string]>): void;
  keyLabel: string; valueLabel: string; keyPlaceholder: string; valuePlaceholder: string; secret?: boolean;
}) {
  const set = (index: number, at: 0 | 1, text: string) => onChange(rows.map((row, position) => position === index ? (at ? [row[0], text] : [text, row[1]]) : row));
  return (
    <div className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {rows.map(([key, value], index) => (
        <div key={index} className="flex items-center gap-1">
          <Input aria-label={`${keyLabel} ${index + 1}`} value={key} placeholder={keyPlaceholder} spellCheck={false} autoComplete="off"
            onChange={(event) => set(index, 0, event.target.value)} className="h-7 min-w-0 flex-1 font-mono text-[0.74rem] md:text-[0.74rem]" />
          <Input aria-label={`${valueLabel} ${index + 1}`} value={value} placeholder={valuePlaceholder} spellCheck={false} autoComplete="off"
            type={secret ? "password" : "text"}
            onChange={(event) => set(index, 1, event.target.value)} className="h-7 min-w-0 flex-[1.4] font-mono text-[0.74rem] md:text-[0.74rem]" />
          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${keyLabel.toLowerCase()} ${key || index + 1}`} onClick={() => onChange(rows.filter((_, position) => position !== index))}><XIcon /></Button>
        </div>
      ))}
      <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => onChange([...rows, ["", ""]])}><PlusIcon data-icon="inline-start" />Add</Button>
    </div>
  );
}

/** Ordered single values, one per row: stdio arguments or passed variable names. */
function Rows({ label, rows, onChange, itemLabel, placeholder, ordered }: {
  label: string; rows: string[]; onChange(rows: string[]): void; itemLabel: string; placeholder: string; ordered?: boolean;
}) {
  const move = (index: number, by: number) => {
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {rows.map((value, index) => (
        <div key={index} className="flex items-center gap-1">
          {ordered ? <span className="w-4 shrink-0 text-right text-[0.64rem] text-muted-foreground tabular-nums">{index + 1}</span> : null}
          <Input aria-label={`${itemLabel} ${index + 1}`} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off"
            onChange={(event) => onChange(rows.map((row, position) => position === index ? event.target.value : row))} className="h-7 min-w-0 flex-1 font-mono text-[0.74rem] md:text-[0.74rem]" />
          {ordered ? (
            <>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${itemLabel.toLowerCase()} ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUpIcon /></Button>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${itemLabel.toLowerCase()} ${index + 1} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDownIcon /></Button>
            </>
          ) : null}
          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((_, position) => position !== index))}><XIcon /></Button>
        </div>
      ))}
      <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => onChange([...rows, ""])}><PlusIcon data-icon="inline-start" />Add</Button>
    </div>
  );
}

function McpFields({ id, value, set, nameProblem }: { id: string; value(field: string): string; set(field: string, value: string): void; nameProblem: string | null }) {
  const form = draftMcpForm(value("definition"));
  const update = (patch: Partial<McpForm>) => set("definition", JSON.stringify({ ...form, ...patch }));
  const [pasted, setPasted] = useState("");
  const { definition } = fromMcpForm(form);
  const literals = definition ? mcpLiterals(definition) : 0;
  return (
    <>
      <NameField id={id} value={value("name")} onChange={(next) => set("name", next)} issue={nameProblem}
        hint="The [mcp_servers] table name in each launch config. It cannot match a default Stack MCP server." />
      <DescriptionField id={id} value={value("description")} onChange={(next) => set("description", next)}
        placeholder="What it provides and who maintains it" hint="Only people see this. It never reaches a Bot." />
      <div className="flex flex-col gap-2.5 rounded-xl border bg-background/50 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className={labelClass}>Transport</span>
          <ToggleGroup value={[form.type]} onValueChange={(next: string[]) => { if (next.length) update({ type: next[0] as McpForm["type"] }); }} spacing={0} size="sm" variant="outline" aria-label="Transport">
            <ToggleGroupItem value="http">HTTP</ToggleGroupItem>
            <ToggleGroupItem value="stdio">stdio</ToggleGroupItem>
          </ToggleGroup>
        </div>
        {form.type === "http" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-url`} className={labelClass}>URL</label>
              <Input id={`${id}-url`} value={form.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} autoComplete="off" type="url"
                onChange={(event) => update({ url: event.target.value })} className="h-8 font-mono text-[0.78rem] md:text-[0.78rem]" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-token`} className={labelClass}>Bearer token variable · optional</label>
              <Input id={`${id}-token`} value={form.bearerTokenEnvVar} placeholder="EXAMPLE_MCP_TOKEN" spellCheck={false} autoComplete="off"
                aria-describedby={`${id}-token-hint`} onChange={(event) => update({ bearerTokenEnvVar: event.target.value })} className="h-8 font-mono text-[0.78rem] md:text-[0.78rem]" />
              <p id={`${id}-token-hint`} className={hintClass}>Codex reads the token from this variable in the Bot’s environment; the Role stores only its name.</p>
            </div>
            <Pairs label="Headers from the environment" rows={form.envHttpHeaders} onChange={(rows) => update({ envHttpHeaders: rows })}
              keyLabel="Header" valueLabel="Variable" keyPlaceholder="X-Api-Key" valuePlaceholder="VARIABLE_NAME" />
            <Pairs label="Literal headers" rows={form.httpHeaders} onChange={(rows) => update({ httpHeaders: rows })}
              keyLabel="Header" valueLabel="Value" keyPlaceholder="X-Client" valuePlaceholder="value" secret />
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-command`} className={labelClass}>Command</label>
              <Input id={`${id}-command`} value={form.command} placeholder="/usr/local/bin/example-mcp" spellCheck={false} autoComplete="off"
                onChange={(event) => update({ command: event.target.value })} className="h-8 font-mono text-[0.78rem] md:text-[0.78rem]" />
              <div className="flex items-center gap-1">
                <Input aria-label="Command line to split" value={pasted} placeholder="Or paste a whole command line" spellCheck={false} autoComplete="off"
                  onChange={(event) => setPasted(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.querySelector<HTMLButtonElement>("[data-split]")?.click(); } }}
                  className="h-7 min-w-0 flex-1 font-mono text-[0.72rem] md:text-[0.72rem]" />
                <Button type="button" data-split size="xs" variant="outline" disabled={!pasted.trim()}
                  onClick={() => { const [command = "", ...args] = splitCommandLine(pasted); update({ command, args }); setPasted(""); }}>Split</Button>
              </div>
              <p className={hintClass}>Runs without a shell: each argument is passed exactly as written, with no expansion.</p>
            </div>
            <Rows label="Arguments" rows={form.args} onChange={(args) => update({ args })} itemLabel="Argument" placeholder="--flag" ordered />
            <Rows label="Variables passed from the Bot’s environment" rows={form.envVars} onChange={(envVars) => update({ envVars })} itemLabel="Variable" placeholder="VARIABLE_NAME" />
            <Pairs label="Literal environment" rows={form.env} onChange={(env) => update({ env })}
              keyLabel="Variable" valueLabel="Value" keyPlaceholder="NAME" valuePlaceholder="value" secret />
          </>
        )}
        {literals ? (
          <p className="flex items-start gap-1.5 px-0.5 text-[0.68rem] text-pretty text-warning">
            <ShieldAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            Literal values are stored in plain text in the Role and in included launches’ connection config. Use environment variables for secrets.
          </p>
        ) : null}
      </div>
      {definition && value("name") && !nameProblem ? (
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>config.toml · connection template before harness selection</span>
          <pre className="rounded-lg border bg-muted/30 px-2.5 py-2 font-mono text-[0.7rem] leading-relaxed break-words whitespace-pre-wrap">{mcpToml(value("name"), definition)}</pre>
        </div>
      ) : null}
    </>
  );
}

export function McpServerEditor({ id }: { id: string }) {
  const { role, roleLaunch, roleInternal } = useStack();
  const actions = useRoleActions();
  const { select } = useWorkbench();
  const formId = useId();
  const saved = useSaved(mcpSpec, id);
  const duplicate = useDuplicate(mcpSpec, id, saved.draft.draft.values);
  if (!saved.found) return <Gone noun="MCP server" draft={saved.draft.draft} onRestore={saved.restore} />;
  const server = saved.found.item;
  const internal = internalNames(roleInternal.data, roleLaunch.data);
  const others = (role.data?.mcpServers ?? []).filter((item) => item.id !== id).map((item) => item.name);
  const { nameProblem, issues, invalid } = mcpProblems(saved.draft.value, others, internal);
  const blocking = roleLaunch.data?.revision === role.data?.revision ? roleLaunch.data?.issues.find((issue) => issue.id === id) : undefined;
  const save = () => saved.save(invalid);
  return (
    <EditorFrame subtitle="MCP server"
      footer={<SaveBar dirty={saved.dirty} conflicts={saved.draft.conflicts.length} pending={saved.saving} invalid={invalid} saveLabel="Save" onSave={save} onRevert={saved.revert} />}
      actions={<RecordMenu label={server.name} onInspect={() => select({ kind: "mcp-server", id })} onDuplicate={duplicate} onDelete={() => actions.confirmDelete({ kind: "mcp-server", id })} />}>
      <form className="flex flex-col gap-3" aria-label={`Edit MCP server ${server.name}`} onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={saveKeys(save)}>
        {blocking ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Selected launch capabilities conflict</AlertTitle>
            <AlertDescription>{blocking.message}. Rename it, change its URL or switch it off.</AlertDescription>
          </Alert>
        ) : null}
        <ConflictNotice fields={saved.draft.conflicts} onKeep={saved.keep} onYield={saved.yield} />
        <EnabledRow id={formId} checked={server.enabled} disabled={!saved.connected || saved.enabling} onChange={saved.setEnabled}
          note={server.enabled ? "New launches connect where its harness filter allows" : "Skipped in new launches"} />
        <McpFields id={formId} value={saved.draft.value} set={saved.draft.set} nameProblem={nameProblem} />
        <Issues issues={issues} />
        <p className={hintClass}>Running Bots keep their connections until restarted.</p>
        <ErrorText error={saved.error} />
      </form>
    </EditorFrame>
  );
}

export function NewMcpServerEditor({ enabled }: { enabled: boolean }) {
  const { role, roleLaunch, roleInternal } = useStack();
  const formId = useId();
  const created = useCreate(mcpSpec, enabled);
  useFocusField(formId, "name");
  const { nameProblem, issues, invalid } = mcpProblems(created.draft.value, (role.data?.mcpServers ?? []).map((item) => item.name), internalNames(roleInternal.data, roleLaunch.data));
  const create = () => created.create(invalid);
  return (
    <EditorFrame subtitle="new MCP server"
      footer={<SaveBar dirty={created.connected} conflicts={0} pending={created.creating} invalid={invalid} saveLabel="Create server" onSave={create} note="Not created yet" />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Discard new MCP server" onClick={created.cancel}><XIcon /></Button>}>
      <form className="flex flex-col gap-3" aria-label="New MCP server" onSubmit={(event) => { event.preventDefault(); create(); }} onKeyDown={saveKeys(create)}>
        <EnabledRow id={formId} checked={enabled} onChange={created.setEnabled} note={enabled ? "New Bots connect to it once created" : "Created switched off"} />
        <McpFields id={formId} value={created.draft.value} set={created.draft.set} nameProblem={nameProblem} />
        <Issues issues={issues} />
        <ErrorText error={created.error} />
        <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={created.cancel}>Discard</Button>
      </form>
    </EditorFrame>
  );
}

/* ─── Trusted projects ───────────────────────────────────────────────── */

const pathInvalid = (path: string): string | null => !path.trim() ? "A project root is required" : !path.startsWith("/") ? "Use an absolute path" : null;

function TrustNotice() {
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <ShieldAlertIcon className="text-warning" />
      <AlertTitle>Trust covers the whole project config</AlertTitle>
      <AlertDescription>
        A Bot launched anywhere inside this root loads the project’s .codex/config.toml, including its MCP servers and any other settings there, not just one server.
      </AlertDescription>
    </Alert>
  );
}

function ProjectFields({ id, value, set }: { id: string; value(field: string): string; set(field: string, value: string): void }) {
  const { bots } = useStack();
  const suggestions = [...new Set((bots.data ?? []).map((bot) => bot.cwd).filter((cwd) => typeof cwd === "string" && cwd.startsWith("/")))];
  const problem = value("path") ? pathInvalid(value("path")) : null;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-path`} className={labelClass}>Project root</label>
        <Input id={`${id}-path`} value={value("path")} list={`${id}-paths`} placeholder="/path/to/project" spellCheck={false} autoComplete="off"
          aria-invalid={problem ? true : undefined} aria-describedby={`${id}-path-hint`}
          onChange={(event) => set("path", event.target.value)} className="h-8 font-mono text-[0.78rem] md:text-[0.78rem]" />
        <datalist id={`${id}-paths`}>{suggestions.map((path) => <option key={path} value={path} />)}</datalist>
        <p id={`${id}-path-hint`} className={cn(hintClass, problem && "text-destructive")}>{problem ?? "An existing directory. It is saved as its canonical path, with symlinks resolved."}</p>
      </div>
      <DescriptionField id={id} value={value("description")} onChange={(next) => set("description", next)}
        placeholder="Why this project is trusted" hint="Only people see this. It never reaches a Bot." />
    </>
  );
}

export function ProjectEditor({ id }: { id: string }) {
  const { role, roleLaunch, bots } = useStack();
  const actions = useRoleActions();
  const { select } = useWorkbench();
  const formId = useId();
  const saved = useSaved(projectSpec, id);
  if (!saved.found) return <Gone noun="trusted project" draft={saved.draft.draft} onRestore={saved.restore} />;
  const project = saved.found.item;
  const invalid = pathInvalid(saved.draft.value("path"));
  const current = roleLaunch.data?.revision === role.data?.revision;
  const inside = project.enabled && current ? projectBots(roleLaunch.data, id, bots.data) : [];
  const save = () => saved.save(invalid);
  return (
    <EditorFrame subtitle="trusted project"
      footer={<SaveBar dirty={saved.dirty} conflicts={saved.draft.conflicts.length} pending={saved.saving} invalid={invalid} saveLabel="Save" onSave={save} onRevert={saved.revert} />}
      actions={<RecordMenu label={project.path} onInspect={() => select({ kind: "trusted-project", id })} onDelete={() => actions.confirmDelete({ kind: "trusted-project", id })} deleteLabel="Remove…" />}>
      <form className="flex flex-col gap-3" aria-label={`Edit trusted project ${project.path}`} onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={saveKeys(save)}>
        <ConflictNotice fields={saved.draft.conflicts} onKeep={saved.keep} onYield={saved.yield} />
        <EnabledRow id={formId} checked={project.enabled} disabled={!saved.connected || saved.enabling} onChange={saved.setEnabled}
          note={project.enabled ? "New Bots inside it trust its config" : "No launch trusts it"}>
          {project.enabled ? (
            inside.length ? (
              <ul className="flex flex-col gap-1" aria-label="Bots inside this root">
                {inside.map((bot) => (
                  <li key={bot.id} className="flex items-center gap-2 text-[0.75rem]">
                    <BotTile bot={bot} className="size-5 rounded-md text-[0.65rem] [&_svg]:size-3" />
                    <NodeLink node={{ kind: "bot", id: bot.id }} label={bot.id} className="font-mono text-[0.72rem]">{bot.id}</NodeLink>
                    <span className="min-w-0 truncate font-mono text-[0.66rem] text-muted-foreground" title={bot.cwd}>{bot.cwd}</span>
                  </li>
                ))}
              </ul>
            ) : <p className={hintClass}>{current ? "No Bot runs inside this root yet." : "Checking which Bots run inside it…"}</p>
          ) : null}
        </EnabledRow>
        <TrustNotice />
        <ProjectFields id={formId} value={saved.draft.value} set={saved.draft.set} />
        <p className={hintClass}>Running Bots keep the trust they launched with until restarted.</p>
        <ErrorText error={saved.error} />
      </form>
    </EditorFrame>
  );
}

export function NewProjectEditor({ enabled }: { enabled: boolean }) {
  const formId = useId();
  const created = useCreate(projectSpec, enabled);
  useFocusField(formId, "path");
  const invalid = pathInvalid(created.draft.value("path"));
  const create = () => created.create(invalid);
  return (
    <EditorFrame subtitle="new trusted project"
      footer={<SaveBar dirty={created.connected} conflicts={0} pending={created.creating} invalid={invalid} saveLabel="Trust project" onSave={create} note="Not trusted yet" />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Discard new trusted project" onClick={created.cancel}><XIcon /></Button>}>
      <form className="flex flex-col gap-3" aria-label="New trusted project" onSubmit={(event) => { event.preventDefault(); create(); }} onKeyDown={saveKeys(create)}>
        <TrustNotice />
        <EnabledRow id={formId} checked={enabled} onChange={created.setEnabled} note={enabled ? "Trusted once added" : "Added switched off"} />
        <ProjectFields id={formId} value={created.draft.value} set={created.draft.set} />
        <ErrorText error={created.error} />
        <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={created.cancel}>Discard</Button>
      </form>
    </EditorFrame>
  );
}
