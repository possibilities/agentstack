"use client";

import { useId, useRef, useState } from "react";
import { FilePenLineIcon, FolderIcon, PlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  addedIds,
  approxTokens,
  categoryText,
  copyTitle,
  descriptionLimit,
  draftChanges,
  draftConflicts,
  findCategory,
  findFragment,
  formatBytes,
  formatCount,
  fragmentState,
  fragmentStateLabel,
  fragmentText,
  keepDraft,
  moveIndex,
  titleLimit,
  utf8Bytes,
  yieldDraft,
  type FragmentState,
} from "@/lib/stack/roles";
import type { RoleCategory, RoleFragment, RoleSnapshot } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { Empty, Time } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { targetKey, useRoleActions, type RoleTarget } from "./role-actions";
import { ConflictNotice, EditorFrame, Gone, hintClass, labelClass, RecordMenu, SaveBar, saveKeys, useDraft, useFocusField } from "./role-editor-parts";
import { McpServerEditor, NewMcpServerEditor, NewProjectEditor, NewSkillEditor, ProjectEditor, SkillEditor } from "./role-resource-editor";

const blankText = { title: "", description: "", body: "" };

const stateTone: Record<FragmentState, string> = {
  renders: "bg-success/15 text-success",
  off: "bg-muted text-muted-foreground",
  "category-off": "bg-muted text-muted-foreground",
  empty: "bg-warning/15 text-warning",
};

/** The one editing surface for Role records. Text edits are drafts until saved; switches and moves apply at once. */
export function RoleEditorWindow() {
  const { role } = useStack();
  const { target } = useRoleActions();
  if (!target) return <EditorFrame empty><Empty icon={FilePenLineIcon} title={role.data?.categories.length ? "Choose a record to edit" : "Nothing to edit yet"} /></EditorFrame>;
  switch (target.kind) {
    case "fragment": return <FragmentEditor key={target.id} id={target.id} />;
    case "category": return <CategoryEditor key={target.id} id={target.id} />;
    case "new-fragment": return <NewFragmentEditor target={target} />;
    case "new-category": return <NewCategoryEditor />;
    case "skill": return <SkillEditor key={target.id} id={target.id} />;
    case "mcp-server": return <McpServerEditor key={target.id} id={target.id} />;
    case "trusted-project": return <ProjectEditor key={target.id} id={target.id} />;
    case "new-skill": return <NewSkillEditor enabled={target.enabled} />;
    case "new-mcp-server": return <NewMcpServerEditor enabled={target.enabled} />;
    case "new-trusted-project": return <NewProjectEditor enabled={target.enabled} />;
  }
}

function TextFields({ id, value, set, body }: { id: string; value(field: string): string; set(field: string, value: string): void; body?: boolean }) {
  const bytes = body ? utf8Bytes(value("body")) : 0;
  const titleEmpty = !value("title").trim();
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-title`} className={labelClass}>Title</label>
        <Input id={`${id}-title`} value={value("title")} maxLength={titleLimit} placeholder={body ? "What this fragment does" : "Category name"}
          aria-invalid={titleEmpty ? true : undefined} onChange={(event) => set("title", event.target.value)} className="h-8" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-description`} className={labelClass}>Description</label>
        <Textarea id={`${id}-description`} value={value("description")} maxLength={descriptionLimit} rows={2}
          placeholder="Why it exists, when to change it" aria-describedby={`${id}-description-hint`}
          onChange={(event) => set("description", event.target.value)} className="max-h-32 min-h-12 resize-none text-[0.8rem] md:text-[0.8rem]" />
        <p id={`${id}-description-hint`} className={hintClass}>Only people see this. It never reaches a Bot.</p>
      </div>
      {body ? (
        <div className="flex min-h-0 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${id}-body`} className={labelClass}>Instructions</label>
            <span className="text-[0.65rem] text-muted-foreground tabular-nums">
              {value("body").length.toLocaleString()} chars · {formatBytes(bytes)} · ≈{formatCount(approxTokens(bytes))} tokens
            </span>
          </div>
          <Textarea id={`${id}-body`} value={value("body")} spellCheck={false} aria-describedby={`${id}-body-hint`}
            placeholder="Write the developer instructions exactly as Bots should read them."
            onChange={(event) => set("body", event.target.value)}
            className="min-h-64 resize-y font-mono text-[0.78rem] leading-relaxed md:text-[0.78rem]" />
          <p id={`${id}-body-hint`} className={hintClass}>Sent verbatim in each new Bot’s SYSTEM_APPEND.md. Blank text renders nothing.</p>
        </div>
      ) : null}
    </>
  );
}

function StateBadge({ state }: { state: FragmentState }) {
  return <span className={cn("rounded px-1.5 py-px text-[0.64rem] font-medium", stateTone[state])}>{fragmentStateLabel[state]}</span>;
}

function Stamps({ record }: { record: { createdAt: number | null; updatedAt: number | null } }) {
  // Records saved before timestamps, or read from an older Roles API, have none to show.
  if (typeof record.createdAt !== "number" && typeof record.updatedAt !== "number") return null;
  return (
    <span className="text-[0.66rem] text-muted-foreground" title={[record.createdAt ? `Created ${new Date(record.createdAt).toLocaleString()}` : null, record.updatedAt ? `Edited ${new Date(record.updatedAt).toLocaleString()}` : null].filter(Boolean).join("\n")}>
      {typeof record.updatedAt === "number" && record.updatedAt !== record.createdAt ? <>Edited <Time at={record.updatedAt} /></> : <>Created <Time at={record.createdAt} /></>}
    </span>
  );
}

function FragmentEditor({ id }: { id: string }) {
  const { role, status } = useStack();
  const actions = useRoleActions();
  const { select } = useWorkbench();
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const found = findFragment(role.data, id);
  const lastSeen = useRef<RoleFragment | null>(null);
  if (found) lastSeen.current = found.fragment;
  const key = `fragment:${id}`;
  const saved = found ? fragmentText(found.fragment) : lastSeen.current ? fragmentText(lastSeen.current) : blankText;
  const draft = useDraft(key, saved);
  const connected = status.roles === "open";
  const saving = actions.pending.has(`save:${key}`);

  if (!found) {
    const restore = () => {
      const categoryId = role.data?.categories.find((category) => category.id === lastSeen.current?.categoryId)?.id ?? role.data?.categories[0]?.id;
      if (!categoryId) return toast.error("Create a category first.");
      actions.setDraft("new-fragment", { base: {}, values: { ...saved, ...draft.draft.values } });
      actions.setDraft(key, null);
      actions.open({ kind: "new-fragment", categoryId, enabled: lastSeen.current?.enabled ?? true });
    };
    return <Gone noun="fragment" draft={draft.draft} onRestore={restore} />;
  }

  const { fragment, category } = found;
  const state = fragmentState(fragment, category);
  const dirty = Object.keys(draft.changes).length > 0;
  const valid = draft.value("title").trim().length > 0;
  const save = () => {
    if (!dirty || !valid || draft.conflicts.length || saving || !connected) return;
    const pendingDraft = draft.draft;
    setError(null);
    actions.write("fragment_update", (snapshot) => {
      const current = findFragment(snapshot, id);
      if (!current) return "This fragment was deleted elsewhere.";
      if (draftConflicts(pendingDraft, fragmentText(current.fragment)).length) return "It changed elsewhere while saving. Choose which version to keep.";
      return { id, ...draftChanges(pendingDraft, fragmentText(current.fragment)) };
    }, `save:${key}`).then(() => draft.clear(), (cause) => setError(errorMessage(cause)));
  };
  const moveTo = (categoryId: string) => actions.act("fragment_move", (snapshot) => {
    const destination = findCategory(snapshot, categoryId)?.category;
    if (!destination) return "That category was deleted.";
    return findFragment(snapshot, id) ? { id, categoryId, index: moveIndex(destination, id, null) } : "This fragment was deleted elsewhere.";
  }, `move:${id}`);
  const duplicate = () => actions.write("fragment_create", (snapshot) => {
    const current = findFragment(snapshot, id);
    if (!current) return "This fragment was deleted elsewhere.";
    const text = { ...fragmentText(current.fragment), ...draft.draft.values };
    return { categoryId: current.category.id, title: copyTitle(text.title.trim() || current.fragment.title), description: text.description, body: text.body, enabled: current.fragment.enabled, index: current.index + 1 };
  }, `duplicate:${id}`).then((snapshot) => {
    const created = addedIds(role.data?.categories.flatMap((item) => item.fragments) ?? [], snapshot.categories.flatMap((item) => item.fragments))[0];
    if (created) actions.open({ kind: "fragment", id: created });
  }, (cause) => toast.error(errorMessage(cause)));

  return (
    <EditorFrame subtitle={`fragment · ${category.title}`}
      footer={<SaveBar dirty={dirty} conflicts={draft.conflicts.length} pending={saving} invalid={valid ? null : "A title is required"} saveLabel="Save" onSave={save} onRevert={() => { draft.clear(); setError(null); }} />}
      actions={<RecordMenu label={fragment.title} onInspect={() => select({ kind: "fragment", id })} onDuplicate={duplicate} onDelete={() => actions.confirmDelete({ kind: "fragment", id })} />}>
      <form className="flex flex-col gap-3" aria-label={`Edit ${fragment.title}`} onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={saveKeys(save)}>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => actions.open({ kind: "category", id: category.id })}
            className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[0.68rem] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <FolderIcon className="size-3" />{category.title}
          </button>
          <StateBadge state={state} />
          <span className="ml-auto"><Stamps record={fragment} /></span>
        </div>
        <ConflictNotice fields={draft.conflicts} onKeep={() => draft.replace(keepDraft(draft.draft, saved))} onYield={() => draft.replace(yieldDraft(draft.draft, saved))} />
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-xl border bg-background/50 px-3 py-2">
          <Switch id={`${formId}-enabled`} size="sm" checked={fragment.enabled} disabled={!connected || actions.pending.has(`enable:${id}`)}
            onCheckedChange={(enabled) => actions.act("fragment_update", (snapshot) => findFragment(snapshot, id) ? { id, enabled } : "This fragment was deleted elsewhere.", `enable:${id}`)} />
          <label htmlFor={`${formId}-enabled`} className="text-[0.78rem]">
            Enabled
            <span className="ml-1.5 text-[0.68rem] text-muted-foreground">
              {state === "renders" ? "Reaches new Bots" : state === "category-off" ? `Its category, ${category.title}, is off` : state === "empty" ? "Nothing to render yet" : "Skipped in new launches"}
            </span>
          </label>
          <FolderIcon className="size-3.5 justify-self-center text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 items-center gap-2">
            <label htmlFor={`${formId}-category`} className="sr-only">Category</label>
            <NativeSelect id={`${formId}-category`} size="sm" className="min-w-0 flex-1" value={category.id} disabled={!connected || actions.pending.has(`move:${id}`)}
              onChange={(event) => moveTo(event.target.value)}>
              {role.data!.categories.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        </div>
        <TextFields id={formId} value={draft.value} set={draft.set} body />
        {error ? <p role="alert" className="px-0.5 text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
      </form>
    </EditorFrame>
  );
}

function CategoryEditor({ id }: { id: string }) {
  const { role, status } = useStack();
  const actions = useRoleActions();
  const { select } = useWorkbench();
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const found = findCategory(role.data, id);
  const lastSeen = useRef<RoleCategory | null>(null);
  if (found) lastSeen.current = found.category;
  const key = `category:${id}`;
  const saved = found ? categoryText(found.category) : lastSeen.current ? categoryText(lastSeen.current) : blankText;
  const draft = useDraft(key, saved);
  const connected = status.roles === "open";
  const saving = actions.pending.has(`save:${key}`);

  if (!found) {
    const restore = () => {
      actions.setDraft("new-category", { base: {}, values: { ...saved, ...draft.draft.values } });
      actions.setDraft(key, null);
      actions.open({ kind: "new-category" });
    };
    return <Gone noun="category" draft={draft.draft} onRestore={restore} />;
  }

  const { category } = found;
  const dirty = Object.keys(draft.changes).length > 0;
  const valid = draft.value("title").trim().length > 0;
  const rendering = category.fragments.filter((fragment) => fragmentState(fragment, category) === "renders").length;
  const save = () => {
    if (!dirty || !valid || draft.conflicts.length || saving || !connected) return;
    const pendingDraft = draft.draft;
    setError(null);
    actions.write("category_update", (snapshot) => {
      const current = findCategory(snapshot, id);
      if (!current) return "This category was deleted elsewhere.";
      if (draftConflicts(pendingDraft, categoryText(current.category)).length) return "It changed elsewhere while saving. Choose which version to keep.";
      return { id, ...draftChanges(pendingDraft, categoryText(current.category)) };
    }, `save:${key}`).then(() => draft.clear(), (cause) => setError(errorMessage(cause)));
  };

  return (
    <EditorFrame subtitle="category"
      footer={<SaveBar dirty={dirty} conflicts={draft.conflicts.length} pending={saving} invalid={valid ? null : "A title is required"} saveLabel="Save" onSave={save} onRevert={() => { draft.clear(); setError(null); }} />}
      actions={<RecordMenu label={category.title} onInspect={() => select({ kind: "category", id })} onDelete={() => actions.confirmDelete({ kind: "category", id })} />}>
      <form className="flex flex-col gap-3" aria-label={`Edit ${category.title}`} onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={saveKeys(save)}>
        <div className="flex items-center gap-1.5">
          <span className="text-[0.68rem] text-muted-foreground">{rendering} of {category.fragments.length} fragment{category.fragments.length === 1 ? "" : "s"} render</span>
          <span className="ml-auto"><Stamps record={category} /></span>
        </div>
        <ConflictNotice fields={draft.conflicts} onKeep={() => draft.replace(keepDraft(draft.draft, saved))} onYield={() => draft.replace(yieldDraft(draft.draft, saved))} />
        <div className="flex items-center gap-3 rounded-xl border bg-background/50 px-3 py-2">
          <Switch id={`${formId}-enabled`} size="sm" checked={category.enabled} disabled={!connected || actions.pending.has(`enable:${id}`)}
            onCheckedChange={(enabled) => actions.act("category_update", (snapshot) => findCategory(snapshot, id) ? { id, enabled } : "This category was deleted elsewhere.", `enable:${id}`)} />
          <label htmlFor={`${formId}-enabled`} className="text-[0.78rem]">
            Enabled
            <span className="ml-1.5 text-[0.68rem] text-muted-foreground">{category.enabled ? "Its enabled fragments reach new Bots" : "None of its fragments reach new Bots"}</span>
          </label>
        </div>
        <TextFields id={formId} value={draft.value} set={draft.set} />
        {error ? <p role="alert" className="px-0.5 text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
      </form>
      <div className="flex flex-col gap-1.5">
        <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Fragments</h3>
        {category.fragments.length ? (
          <ol className="flex flex-col rounded-xl border bg-background/50 p-1">
            {category.fragments.map((fragment, index) => (
              <li key={fragment.id}>
                <button type="button" onClick={() => actions.open({ kind: "fragment", id: fragment.id })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="w-4 shrink-0 text-right text-[0.65rem] text-muted-foreground tabular-nums">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.8rem]">{fragment.title}</span>
                  <StateBadge state={fragmentState(fragment, category)} />
                </button>
              </li>
            ))}
          </ol>
        ) : <p className={hintClass}>No fragments yet. Only empty categories can be deleted.</p>}
        <Button size="sm" variant="outline" className="self-start" disabled={!connected} onClick={() => actions.open({ kind: "new-fragment", categoryId: id, enabled: true })}>
          <PlusIcon data-icon="inline-start" />Add fragment
        </Button>
      </div>
    </EditorFrame>
  );
}

function NewFragmentEditor({ target }: { target: Extract<RoleTarget, { kind: "new-fragment" }> }) {
  const { role, status } = useStack();
  const actions = useRoleActions();
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const key = targetKey(target);
  const draft = useDraft(key, blankText);
  const category = findCategory(role.data, target.categoryId)?.category;
  const connected = status.roles === "open";
  const creating = actions.pending.has(`save:${key}`);
  const valid = draft.value("title").trim().length > 0;
  useFocusField(formId);

  const create = () => {
    if (!valid || creating || !connected) return;
    const { title, description, body } = { ...blankText, ...draft.draft.values };
    const before = role.data?.categories.flatMap((item) => item.fragments) ?? [];
    setError(null);
    actions.write("fragment_create", (snapshot: RoleSnapshot) => {
      const destination = findCategory(snapshot, target.categoryId)?.category;
      if (!destination) return "That category was deleted. Choose another.";
      return { categoryId: target.categoryId, title, description, body, enabled: target.enabled,
        ...(target.index !== undefined ? { index: Math.min(target.index, destination.fragments.length) } : {}) };
    }, `save:${key}`).then((snapshot) => {
      draft.clear();
      const created = addedIds(before, snapshot.categories.flatMap((item) => item.fragments))[0];
      actions.open(created ? { kind: "fragment", id: created } : null);
    }, (cause) => setError(errorMessage(cause)));
  };
  const cancel = () => { draft.clear(); actions.open(null); };

  return (
    <EditorFrame subtitle="new fragment"
      footer={<SaveBar dirty={connected} conflicts={0} pending={creating} invalid={!category ? "Choose a category" : valid ? null : "A title is required"} saveLabel="Create fragment" onSave={create} note="Not created yet" />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Discard new fragment" onClick={cancel}><XIcon /></Button>}>
      <form className="flex flex-col gap-3" aria-label="New fragment" onSubmit={(event) => { event.preventDefault(); create(); }} onKeyDown={saveKeys(create)}>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-xl border bg-background/50 px-3 py-2">
          <FolderIcon className="size-3.5 justify-self-center text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${formId}-category`} className="sr-only">Category</label>
            <NativeSelect id={`${formId}-category`} size="sm" className="w-full" value={category ? target.categoryId : ""}
              onChange={(event) => actions.open({ kind: "new-fragment", categoryId: event.target.value, enabled: target.enabled })}>
              {category ? null : <NativeSelectOption value="" disabled>Choose a category</NativeSelectOption>}
              {role.data?.categories.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <Switch id={`${formId}-enabled`} size="sm" checked={target.enabled} onCheckedChange={(enabled) => actions.open({ ...target, enabled })} />
          <label htmlFor={`${formId}-enabled`} className="text-[0.78rem]">
            Enabled
            <span className="ml-1.5 text-[0.68rem] text-muted-foreground">{target.enabled ? (category && !category.enabled ? "Its category is off" : "Reaches new Bots once created") : "Created switched off"}</span>
          </label>
        </div>
        <TextFields id={formId} value={draft.value} set={draft.set} body />
        {error ? <p role="alert" className="px-0.5 text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
        <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={cancel}>Discard</Button>
      </form>
    </EditorFrame>
  );
}

function NewCategoryEditor() {
  const { role, status } = useStack();
  const actions = useRoleActions();
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const key = "new-category";
  const draft = useDraft(key, blankText);
  const connected = status.roles === "open";
  const creating = actions.pending.has(`save:${key}`);
  const valid = draft.value("title").trim().length > 0;
  useFocusField(formId);

  const create = () => {
    if (!valid || creating || !connected) return;
    const { title, description } = { ...blankText, ...draft.draft.values };
    const before = role.data?.categories ?? [];
    setError(null);
    actions.write("category_create", () => ({ title, description }), `save:${key}`).then((snapshot) => {
      draft.clear();
      const created = addedIds(before, snapshot.categories)[0];
      actions.open(created ? { kind: "category", id: created } : null);
    }, (cause) => setError(errorMessage(cause)));
  };
  const cancel = () => { draft.clear(); actions.open(null); };

  return (
    <EditorFrame subtitle="new category"
      footer={<SaveBar dirty={connected} conflicts={0} pending={creating} invalid={valid ? null : "A title is required"} saveLabel="Create category" onSave={create} note="Not created yet" />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Discard new category" onClick={cancel}><XIcon /></Button>}>
      <form className="flex flex-col gap-3" aria-label="New category" onSubmit={(event) => { event.preventDefault(); create(); }} onKeyDown={saveKeys(create)}>
        <p className={hintClass}>Categories group and order fragments. Their names and descriptions are for people; switching one off skips all of its fragments.</p>
        <TextFields id={formId} value={draft.value} set={draft.set} />
        {error ? <p role="alert" className="px-0.5 text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
        <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={cancel}>Discard</Button>
      </form>
    </EditorFrame>
  );
}


