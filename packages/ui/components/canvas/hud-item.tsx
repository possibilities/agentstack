"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, BracesIcon, CheckIcon, ChevronRightIcon, CrosshairIcon, FileTextIcon, FolderInputIcon, LinkIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { shortId } from "@/lib/stack/derive";
import { ancestorsOf, appendOrder, attentionKinds, isTerminal, linkRelations, openDescendants, parseLabels, priorities, reopenAncestors, rowIndex, siblingsOf, stateView, stepOrder, workStates } from "@/lib/stack/hud";
import type { WorkItem, WorkLink, WorkReference, WorkState } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { ActorName, AttentionChip, HudPlaceholder, hudReadOnly, ReferenceLink, RequestNotice, StateMark, useHudRequest, type HudRequest } from "./hud-shared";
import { NewWorkForm, ParentSelect } from "./hud-work";
import { useProcSnapshot } from "./proc-shared";
import { CopyButton, Row, Time } from "./primitives";
import { useHudView, useStack, useStore } from "./provider";
import { Section, Window } from "./window";

/**
 * One Work item: its objective, scope and next step, and the edits people and agents
 * make together. Edits are revision-checked; a concurrent change keeps your draft and
 * shows theirs beside it. Nothing here starts, stops or approves native execution.
 */
export function ItemWindow() {
  const { hudTree, hudItemGenerations, status, endpoints, remote } = useStack();
  const store = useStore();
  const { view, hudView } = useHudView();
  const id = view.selectedId;
  useEffect(() => id ? store.watchWorkItem(id) : undefined, [id, store]);
  const detail = useProcSnapshot<WorkItem>(id, id ? hudItemGenerations[id] ?? 0 : 0, () => store.call<WorkItem>("hud", "work_get", { id: id! }));
  const rows = hudTree.data?.rows ?? [];
  const byId = useMemo(() => rowIndex(rows), [rows]);
  const row = id ? byId.get(id) : undefined;
  // The tree's copy shows at once; the item's own read is authoritative once it lands.
  const item = detail.data ?? row?.item ?? null;
  const readOnly = hudReadOnly(remote, endpoints.hud);
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [id]);
  const missing = Boolean(detail.error && /work_not_found/.test(detail.error));

  return (
    <Window id="hud-item" title={item?.title ?? "Work item"} subtitle={item ? `rev ${item.revision} · scope ${item.scopeRevision}` : "hud"} icon={FileTextIcon} accent="hud"
      node={item ? { kind: "work-item", id: item.id } : undefined} empty={!item}
      status={status.hud} endpoint={endpoints.hud} updatedAt={detail.at} error={missing ? null : detail.error}
      actions={item ? (
        <Button size="icon-sm" variant="ghost" aria-label="Show only this subtree" title="Show only this subtree in Work" onClick={() => hudView.focusSubtree(item.id)}>
          <CrosshairIcon />
        </Button>
      ) : undefined}
      footer={item && !readOnly && !isTerminal(item.state) ? (
        <Button variant="ghost" size="sm" className="w-full justify-center text-muted-foreground hover:text-foreground" aria-expanded={adding} onClick={() => setAdding((value) => !value)}>
          <PlusIcon data-icon="inline-start" />Add a child
        </Button>
      ) : undefined}>
      {!id ? <HudPlaceholder title="Choose work" hint="Pick an item in the Work tree or the attention list." icon={FileTextIcon} />
        : missing ? <HudPlaceholder title="This item no longer exists" hint="It may have been removed from another place." icon={FileTextIcon} />
        : !item ? <HudPlaceholder title={detail.error ? "Work unavailable" : "Reading work…"} hint={detail.error ?? undefined} icon={FileTextIcon} />
        : (
          <>
            {adding ? <NewWorkForm parentId={item.id} onDone={(created) => { setAdding(false); if (created) hudView.select(created); }} /> : null}
            <Breadcrumb item={item} />
            <ItemEditor key={item.id} item={item} readOnly={readOnly} />
          </>
        )}
    </Window>
  );
}

function Breadcrumb({ item }: { item: WorkItem }) {
  const { hudTree } = useStack();
  const { hudView } = useHudView();
  const byId = useMemo(() => rowIndex(hudTree.data?.rows ?? []), [hudTree.data]);
  const ancestors = ancestorsOf(item.id, byId).reverse();
  if (!item.parentId) return <p className="text-[0.7rem] text-muted-foreground">Top-level work</p>;
  return (
    <nav aria-label="Ancestors" className="flex flex-wrap items-center gap-0.5 text-[0.7rem] text-muted-foreground">
      {ancestors.length && ancestors[0].parentId ? <span>…</span> : null}
      {ancestors.map((ancestor) => (
        <span key={ancestor.id} className="flex min-w-0 items-center gap-0.5">
          <button type="button" onClick={() => hudView.select(ancestor.id)} className="max-w-40 truncate rounded-sm hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">{ancestor.title}</button>
          {isTerminal(ancestor.state) ? <StateMark state={ancestor.state} /> : null}
          <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
        </span>
      ))}
      {!ancestors.length ? <span className="font-mono">parent {shortId(item.parentId)} isn’t loaded</span> : null}
    </nav>
  );
}

function ItemEditor({ item, readOnly }: { item: WorkItem; readOnly: string | null }) {
  const { hudTree } = useStack();
  const rows = hudTree.data?.rows ?? [];
  const byId = useMemo(() => rowIndex(rows), [rows]);
  const row = byId.get(item.id);
  const titles = useMemo(() => new Map(rows.map((entry) => [entry.item.id, entry.item.title])), [rows]);
  return (
    <>
      <div className="flex flex-col gap-2">
        <EditableText item={item} field="title" label="Title" readOnly={readOnly} maxLength={200} single />
        <StatusControls item={item} readOnly={readOnly} />
      </div>
      <EditableText item={item} field="objective" label="Objective" readOnly={readOnly} maxLength={8000} />
      <EditableText item={item} field="nextAction" label="Next action" readOnly={readOnly} maxLength={2000} placeholder="No next action recorded" />
      <EditableText item={item} field="summary" label="Summary" readOnly={readOnly} maxLength={2000} placeholder="No summary yet" />
      <Section title="Readiness">
        <dl className="flex flex-col">
          <Row label="Children" hint="Direct children and how many descendants are still open. A count, not progress.">
            {row ? (row.childCount ? `${row.childCount} · ${row.openDescendants} open below` : "None") : "Not in the loaded tree"}
          </Row>
        </dl>
        <Dependencies item={item} titles={titles} readOnly={readOnly} unmet={row?.unmetDependencies ?? null} />
      </Section>
      <Placement item={item} readOnly={readOnly} />
      <Links item={item} titles={titles} readOnly={readOnly} />
      <Labels item={item} readOnly={readOnly} />
      <Section title="Record">
        <dl className="flex flex-col">
          <Row label="Revision" hint="Advances on every durable edit, note and metadata change." mono>{item.revision}</Row>
          <Row label="Scope revision" hint="Advances when the objective, parent or dependencies change. Results and Worker turns record the scope they belong to." mono>{item.scopeRevision}</Row>
          <Row label="Created"><span className="flex items-center gap-1"><ActorName actor={item.createdBy} /> · <Time at={item.createdAt} /></span></Row>
          <Row label="Last edited"><span className="flex items-center gap-1"><ActorName actor={item.updatedBy} /> · <Time at={item.updatedAt} /></span></Row>
          <Row label="ID" mono copy={item.id}>{shortId(item.id)}</Row>
        </dl>
      </Section>
      <Metadata item={item} readOnly={readOnly} />
    </>
  );
}

type TextField = "title" | "objective" | "nextAction" | "summary";

/**
 * A text field edited against the revision it started from. Concurrent edits show
 * beside the draft; a conflict never discards it. Saving over a newer version is an
 * explicit choice with a fresh request.
 */
function EditableText({ item, field, label, readOnly, maxLength, single, placeholder }: {
  item: WorkItem; field: TextField; label: string; readOnly: string | null; maxLength: number; single?: boolean; placeholder?: string;
}) {
  const [draft, setDraft] = useState<{ text: string; base: string; revision: number } | null>(null);
  const request = useHudRequest(() => setDraft(null));
  const live = item[field];
  const changed = draft !== null && draft.base !== live;
  const save = (revision: number) => {
    if (!draft) return;
    const text = field === "title" || field === "objective" ? draft.text.trim() : draft.text;
    void request.submit("work_update", { id: item.id, expectedRevision: revision, patch: { [field]: text } });
  };
  const editing = draft !== null;
  const invalid = draft !== null && (field === "title" || field === "objective") && !draft.text.trim();
  const locked = request.running || request.held;
  return (
    <div className="group/field flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">{label}</h3>
        {!readOnly && !editing ? (
          <button type="button" aria-label={`Edit ${label.toLowerCase()}`} onClick={() => setDraft({ text: live, base: live, revision: item.revision })}
            className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/field:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(hover:none)]:opacity-100">
            <PencilIcon className="size-3" />
          </button>
        ) : null}
      </div>
      {!editing ? (
        live ? <p className={cn("px-0.5 text-pretty whitespace-pre-wrap", field === "title" ? "text-[0.95rem] font-semibold" : "text-[0.8rem]")}>{live}</p>
          : <p className="px-0.5 text-[0.75rem] text-muted-foreground">{placeholder ?? "—"}</p>
      ) : (
        <form className="flex flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); if (!invalid && !locked) save(draft.revision); }}>
          {single ? (
            <Input autoFocus value={draft.text} maxLength={maxLength} disabled={locked} aria-label={label} onChange={(event) => setDraft({ ...draft, text: event.target.value })} className="h-8 text-[0.8rem]" />
          ) : (
            <Textarea autoFocus value={draft.text} maxLength={maxLength} disabled={locked} rows={field === "objective" ? 5 : 3} aria-label={label}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })} className="text-[0.8rem]" />
          )}
          {changed ? (
            <div className="flex flex-col gap-1 rounded-lg bg-warning/10 px-2.5 py-2 text-[0.72rem] text-pretty">
              <p className="text-warning"><ActorName actor={item.updatedBy} /> changed this while you were editing (revision {draft.revision} → {item.revision}). Current text:</p>
              <p className="whitespace-pre-wrap text-foreground/90">{live || "—"}</p>
            </div>
          ) : null}
          <RequestNotice request={request} conflict={
            <div role="alert" className="flex flex-col gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-[0.72rem] text-pretty text-warning">
              <p>Someone changed this item after you started (now revision {item.revision}). Your draft is kept.{changed ? " Compare it with the current text above." : " This field itself is unchanged."}</p>
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" variant="outline" disabled={request.running || invalid} onClick={() => { request.clear(); setDraft({ ...draft, base: live, revision: item.revision }); save(item.revision); }}>
                  <CheckIcon data-icon="inline-start" />Save mine over revision {item.revision}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => { request.clear(); setDraft(null); }}><XIcon data-icon="inline-start" />Discard mine</Button>
              </div>
            </div>
          } />
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" disabled={request.running} onClick={() => { request.clear(); setDraft(null); }}>Cancel</Button>
            <Button type="submit" size="xs" disabled={invalid || locked || draft.text === live}>
              {request.running ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}Save
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

type Plan = { title: string; description: React.ReactNode; confirm: string; changes: Array<{ action: "update"; id: string; expectedRevision: number; patch: Record<string, unknown> }> };

/**
 * State, priority and attention. Changing state never runs anything. Completion that
 * needs open descendants closed, or reopening under a completed ancestor, is offered as
 * one atomic batch the API validates against the final graph.
 */
function StatusControls({ item, readOnly }: { item: WorkItem; readOnly: string | null }) {
  const { hudTree } = useStack();
  const rows = hudTree.data?.rows ?? [];
  const request = useHudRequest(() => setPlan(null));
  const [plan, setPlan] = useState<Plan | null>(null);
  const update = (patch: Record<string, unknown>) => void request.submit("work_update", { id: item.id, expectedRevision: item.revision, patch });
  const changeState = (state: WorkState) => {
    if (state === item.state) return;
    const byId = rowIndex(rows);
    if (!isTerminal(state) && isTerminal(item.state)) {
      const closed = reopenAncestors(item.id, byId);
      if (closed.length) {
        setPlan({ title: `Reopen ${closed.length === 1 ? "its completed ancestor" : `${closed.length} completed ancestors`} too?`, confirm: "Reopen together",
          description: <>Open work can’t sit under completed work. This reopens {closed.map((ancestor) => `“${ancestor.title}”`).join(", ")} as active in the same change.</>,
          changes: [...closed.map((ancestor) => ({ action: "update" as const, id: ancestor.id, expectedRevision: ancestor.revision, patch: { state: "active" } })),
            { action: "update", id: item.id, expectedRevision: item.revision, patch: { state } }] });
        return;
      }
    }
    if (state === "completed") {
      const open = openDescendants(item.id, rows);
      if (open.length) {
        setPlan({ title: `Complete ${open.length} open descendant${open.length === 1 ? "" : "s"} too?`, confirm: "Complete all",
          description: <>Completion requires every descendant to be closed. This marks {open.length === 1 ? `“${open[0].title}”` : `${open.length} items`} completed in the same change; it fails as a whole if any has unmet dependencies. Nothing is started or stopped.</>,
          changes: [...open.map((child) => ({ action: "update" as const, id: child.id, expectedRevision: child.revision, patch: { state: "completed" } })),
            { action: "update", id: item.id, expectedRevision: item.revision, patch: { state } }] });
        return;
      }
    }
    update({ state });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StateMark state={item.state} />
        <NativeSelect size="sm" value={item.state} disabled={Boolean(readOnly) || request.running || request.held} aria-label="State" onChange={(event) => changeState(event.target.value as WorkState)}>
          {workStates.map((state) => <NativeSelectOption key={state} value={state}>{stateView[state].word}</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect size="sm" value={item.priority} disabled={Boolean(readOnly) || request.running || request.held} aria-label="Priority" onChange={(event) => update({ priority: event.target.value })}>
          {priorities.map((priority) => <NativeSelectOption key={priority} value={priority}>{priority[0].toUpperCase() + priority.slice(1)}</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect size="sm" value={item.attention} disabled={Boolean(readOnly) || request.running || request.held} aria-label="Attention" onChange={(event) => update({ attention: event.target.value })}>
          {attentionKinds.map((kind) => <NativeSelectOption key={kind} value={kind}>{kind === "none" ? "No marker" : kind === "human" ? "Needs a human" : "Needs an agent"}</NativeSelectOption>)}
        </NativeSelect>
        <AttentionChip attention={item.attention} />
        {request.running ? <Spinner className="size-3.5" /> : null}
      </div>
      <RequestNotice request={request} conflict={
        <p role="alert" className="rounded-lg bg-warning/10 px-2.5 py-2 text-[0.72rem] text-pretty text-warning">
          It changed meanwhile and now shows the current values. Choose again if you still want the change. <button type="button" className="underline underline-offset-2" onClick={request.clear}>Dismiss</button>
        </p>
      } />
      <AlertDialog open={plan !== null} onOpenChange={(open) => { if (!open && !request.running) { setPlan(null); if (!request.held) request.clear(); } }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{plan?.title}</AlertDialogTitle>
            <AlertDialogDescription>{plan?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <RequestNotice request={request} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={request.running}>Cancel</AlertDialogCancel>
            <Button disabled={!plan || request.running || request.held} onClick={() => plan && void request.submit("work_batch", { changes: plan.changes })}>
              {request.running ? <Spinner data-icon="inline-start" /> : null}{plan?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Dependencies({ item, titles, readOnly, unmet }: { item: WorkItem; titles: Map<string, string>; readOnly: string | null; unmet: string[] | null }) {
  const { hudTree } = useStack();
  const rows = hudTree.data?.rows ?? [];
  const byId = useMemo(() => rowIndex(rows), [rows]);
  const request = useHudRequest();
  const [adding, setAdding] = useState("");
  const set = (dependencies: string[]) => void request.submit("work_update", { id: item.id, expectedRevision: item.revision, patch: { dependencies } });
  const candidates = rows.filter((row) => row.item.id !== item.id && !item.dependencies.includes(row.item.id));
  const locked = Boolean(readOnly) || request.running || request.held;
  return (
    <div className="flex flex-col gap-1">
      <p className="px-0.5 text-[0.72rem] text-muted-foreground">
        {item.dependencies.length ? `Depends on ${item.dependencies.length}${unmet ? `; ${unmet.length} not completed yet` : ""}. A cancelled dependency is still unmet.` : "No dependencies."}
      </p>
      {item.dependencies.length ? (
        <ul className="flex flex-col gap-0.5">
          {item.dependencies.map((id) => {
            const dependency = byId.get(id)?.item;
            return (
              <li key={id} className="group/row flex min-h-6 items-center gap-1.5 rounded-md px-1 text-[0.78rem] hover:bg-muted/60">
                {dependency ? <StateMark state={dependency.state} /> : null}
                <ReferenceLink reference={{ kind: "work", workItemId: id }} titles={titles} />
                {unmet?.includes(id) ? <span className="text-[0.66rem] text-warning">unmet</span> : null}
                {!readOnly ? (
                  <button type="button" disabled={locked} aria-label={`Remove dependency ${titles.get(id) ?? id}`} onClick={() => set(item.dependencies.filter((value) => value !== id))}
                    className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40">
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!readOnly && candidates.length ? (
        <div className="flex gap-1.5">
          <NativeSelect size="sm" value={adding} disabled={locked} aria-label="Add a dependency" onChange={(event) => setAdding(event.target.value)} className="min-w-0 flex-1">
            <NativeSelectOption value="">Add a dependency…</NativeSelectOption>
            {candidates.map((row) => <NativeSelectOption key={row.item.id} value={row.item.id}>{`${" ".repeat(Math.min(row.depth, 8))}${row.item.title}`}</NativeSelectOption>)}
          </NativeSelect>
          <Button size="sm" variant="outline" disabled={!adding || locked} onClick={() => { set([...item.dependencies, adding]); setAdding(""); }}>Add</Button>
        </div>
      ) : null}
      <RequestNotice request={request} conflict={<ConflictNote request={request} />} />
    </div>
  );
}

function ConflictNote({ request }: { request: HudRequest }) {
  return (
    <p role="alert" className="rounded-lg bg-warning/10 px-2.5 py-2 text-[0.72rem] text-pretty text-warning">
      It changed meanwhile; the current version is shown. Make the change again if it still applies. <button type="button" className="underline underline-offset-2" onClick={request.clear}>Dismiss</button>
    </p>
  );
}

/** Parent and sibling order. A move changes scope; closed work must reopen first. */
function Placement({ item, readOnly }: { item: WorkItem; readOnly: string | null }) {
  const { hudTree } = useStack();
  const rows = hudTree.data?.rows ?? [];
  const request = useHudRequest(() => setMoving(false));
  const [moving, setMoving] = useState(false);
  const [parentId, setParentId] = useState<string | null>(item.parentId);
  useEffect(() => { if (!moving) setParentId(item.parentId); }, [item.parentId, moving]);
  const siblings = siblingsOf(item.parentId, rows);
  const step = (direction: -1 | 1) => {
    const edits = stepOrder(item, siblings, direction);
    if (!edits) return;
    if (edits.length === 1) void request.submit("work_update", { id: item.id, expectedRevision: item.revision, patch: { order: edits[0].order } });
    else void request.submit("work_batch", { changes: edits.map(({ item: sibling, order }) => ({ action: "update", id: sibling.id, expectedRevision: sibling.revision, patch: { order } })) });
  };
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  const locked = Boolean(readOnly) || request.running || request.held;
  return (
    <Section title="Placement" aside={!readOnly ? (
      <div className="flex items-center gap-0.5">
        <Button size="icon-xs" variant="ghost" aria-label="Move up among siblings" disabled={locked || index <= 0} onClick={() => step(-1)}><ArrowUpIcon /></Button>
        <Button size="icon-xs" variant="ghost" aria-label="Move down among siblings" disabled={locked || index < 0 || index >= siblings.length - 1} onClick={() => step(1)}><ArrowDownIcon /></Button>
        <Button size="xs" variant="ghost" aria-expanded={moving} disabled={locked} onClick={() => setMoving((value) => !value)}><FolderInputIcon data-icon="inline-start" />Move</Button>
      </div>
    ) : undefined}>
      <p className="px-0.5 text-[0.72rem] text-muted-foreground">
        {index >= 0 ? `${index + 1} of ${siblings.length} under ${item.parentId ? "its parent" : "the top level"}.` : "Its position isn’t in the loaded tree."}
      </p>
      {moving ? (
        <div className="flex flex-col gap-1.5">
          <ParentSelect value={parentId} exclude={item.id} disabled={locked} onChange={setParentId} />
          <p className="px-0.5 text-[0.7rem] text-muted-foreground">Moves to the end of the new parent’s children and starts a new scope revision.</p>
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setMoving(false)}>Cancel</Button>
            <Button size="xs" disabled={locked || parentId === item.parentId}
              onClick={() => void request.submit("work_update", { id: item.id, expectedRevision: item.revision, patch: { parentId, order: appendOrder(parentId, rows) } })}>
              {request.running ? <Spinner data-icon="inline-start" /> : null}Move here
            </Button>
          </div>
        </div>
      ) : null}
      <RequestNotice request={request} conflict={<ConflictNote request={request} />} />
    </Section>
  );
}

type LinkDraft = { relation: WorkLink["relation"]; kind: WorkReference["kind"]; value: string; extra: string; pkg: string; resource: string; label: string };
const emptyLink: LinkDraft = { relation: "related", kind: "url", value: "", extra: "", pkg: "", resource: "", label: "" };

function linkTarget(draft: LinkDraft, bots: { id: string; mainThreadId: string | null }[]): WorkReference | null {
  const value = draft.value.trim();
  switch (draft.kind) {
    case "operator": return { kind: "operator" };
    case "url": return /^https?:\/\/\S+$/.test(value) ? { kind: "url", url: value } : null;
    case "work": return value ? { kind: "work", workItemId: value } : null;
    case "worker": return value ? { kind: "worker", workerId: value, turnId: null } : null;
    case "bot": case "chat": {
      const bot = bots.find((item) => item.id === value);
      if (!bot?.mainThreadId) return null;
      return draft.kind === "bot" ? { kind: "bot", botId: bot.id, mainThreadId: bot.mainThreadId } : { kind: "chat", botId: bot.id, mainThreadId: bot.mainThreadId, threadId: bot.mainThreadId };
    }
    case "resource": {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.pkg.trim()) || !draft.resource.trim() || !value) return null;
      return { kind: "resource", package: draft.pkg.trim(), resource: draft.resource.trim(), id: value, version: draft.extra.trim() || null };
    }
  }
}

/** Typed links: who leads and contributes, and the evidence, outputs and context. A link declares; it doesn't prove a resource exists. */
function Links({ item, titles, readOnly }: { item: WorkItem; titles: Map<string, string>; readOnly: string | null }) {
  const { bots, workerSessions, hudTree } = useStack();
  const request = useHudRequest(() => setDraft(null));
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const set = (links: WorkLink[]) => void request.submit("work_update", { id: item.id, expectedRevision: item.revision, patch: { links } });
  const running = (bots.data ?? []).filter((bot) => bot.mainThreadId);
  const target = draft ? linkTarget(draft, running) : null;
  const locked = Boolean(readOnly) || request.running || request.held;
  const grouped = linkRelations.map((relation) => ({ relation, links: item.links.map((link, index) => ({ link, index })).filter(({ link }) => link.relation === relation) })).filter((group) => group.links.length);
  return (
    <Section title="Links" aside={!readOnly && !draft ? <Button size="xs" variant="ghost" disabled={locked || item.links.length >= 64} onClick={() => setDraft(emptyLink)}><LinkIcon data-icon="inline-start" />Add</Button> : undefined}>
      {grouped.length ? (
        <dl className="flex flex-col gap-1">
          {grouped.map(({ relation, links }) => (
            <div key={relation} className="flex flex-col gap-0.5">
              <dt className="px-0.5 text-[0.66rem] text-muted-foreground capitalize">{relation}</dt>
              {links.map(({ link, index }) => (
                <dd key={index} className="group/row flex min-h-6 items-center gap-1.5 rounded-md px-1 text-[0.78rem] hover:bg-muted/60">
                  <ReferenceLink reference={link.target} titles={titles} />
                  {link.label ? <span className="truncate text-muted-foreground">“{link.label}”</span> : null}
                  {!readOnly ? (
                    <button type="button" disabled={locked} aria-label="Remove link" onClick={() => set(item.links.filter((_, position) => position !== index))}
                      className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40">
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </dd>
              ))}
            </div>
          ))}
        </dl>
      ) : <p className="px-0.5 text-[0.72rem] text-muted-foreground">No links.</p>}
      {draft ? (
        <form className="flex flex-col gap-1.5 rounded-lg border p-2" onSubmit={(event) => { event.preventDefault(); if (target && !locked) set([...item.links, { relation: draft.relation, target, label: draft.label.trim() }]); }}>
          <div className="grid grid-cols-2 gap-1.5">
            <NativeSelect size="sm" value={draft.relation} aria-label="Relation" onChange={(event) => setDraft({ ...draft, relation: event.target.value as WorkLink["relation"] })} className="w-full">
              {linkRelations.map((relation) => <NativeSelectOption key={relation} value={relation}>{relation[0].toUpperCase() + relation.slice(1)}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect size="sm" value={draft.kind} aria-label="Target kind" onChange={(event) => setDraft({ ...emptyLink, relation: draft.relation, label: draft.label, kind: event.target.value as WorkReference["kind"] })} className="w-full">
              <NativeSelectOption value="url">Web link</NativeSelectOption>
              <NativeSelectOption value="work">Work item</NativeSelectOption>
              <NativeSelectOption value="bot">Bot</NativeSelectOption>
              <NativeSelectOption value="chat">Bot chat</NativeSelectOption>
              <NativeSelectOption value="worker">Worker</NativeSelectOption>
              <NativeSelectOption value="resource">Stack resource</NativeSelectOption>
              <NativeSelectOption value="operator">Operator</NativeSelectOption>
            </NativeSelect>
          </div>
          {draft.kind === "url" ? <Input value={draft.value} placeholder="https://…" aria-label="URL" onChange={(event) => setDraft({ ...draft, value: event.target.value })} className="h-7 text-[0.78rem]" /> : null}
          {draft.kind === "work" ? (
            <NativeSelect size="sm" value={draft.value} aria-label="Work item" onChange={(event) => setDraft({ ...draft, value: event.target.value })} className="w-full">
              <NativeSelectOption value="">Choose work…</NativeSelectOption>
              {(hudTree.data?.rows ?? []).filter((row) => row.item.id !== item.id).map((row) => <NativeSelectOption key={row.item.id} value={row.item.id}>{`${" ".repeat(Math.min(row.depth, 8))}${row.item.title}`}</NativeSelectOption>)}
            </NativeSelect>
          ) : null}
          {draft.kind === "bot" || draft.kind === "chat" ? (
            <NativeSelect size="sm" value={draft.value} aria-label="Bot" onChange={(event) => setDraft({ ...draft, value: event.target.value })} className="w-full">
              <NativeSelectOption value="">{running.length ? "Choose a Bot…" : "No Bot has a main thread"}</NativeSelectOption>
              {running.map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{draft.kind === "chat" ? `${bot.id} main chat` : bot.id}</NativeSelectOption>)}
            </NativeSelect>
          ) : null}
          {draft.kind === "worker" ? (
            <NativeSelect size="sm" value={draft.value} aria-label="Worker" onChange={(event) => setDraft({ ...draft, value: event.target.value })} className="w-full">
              <NativeSelectOption value="">Choose a Worker…</NativeSelectOption>
              {(workerSessions.data ?? []).map((worker) => <NativeSelectOption key={worker.id} value={worker.id}>{`${worker.repo.split("/").pop()} · ${shortId(worker.id, 6)} · ${worker.phase}`}</NativeSelectOption>)}
            </NativeSelect>
          ) : null}
          {draft.kind === "resource" ? (
            <div className="grid grid-cols-2 gap-1.5">
              <Input value={draft.pkg} placeholder="package (content)" aria-label="Package" onChange={(event) => setDraft({ ...draft, pkg: event.target.value })} className="h-7 text-[0.78rem]" />
              <Input value={draft.resource} placeholder="resource (artifact)" aria-label="Resource type" onChange={(event) => setDraft({ ...draft, resource: event.target.value })} className="h-7 text-[0.78rem]" />
              <Input value={draft.value} placeholder="id" aria-label="Resource ID" onChange={(event) => setDraft({ ...draft, value: event.target.value })} className="h-7 text-[0.78rem]" />
              <Input value={draft.extra} placeholder="version (optional)" aria-label="Version" onChange={(event) => setDraft({ ...draft, extra: event.target.value })} className="h-7 text-[0.78rem]" />
            </div>
          ) : null}
          <Input value={draft.label} maxLength={200} placeholder="Label (optional)" aria-label="Label" onChange={(event) => setDraft({ ...draft, label: event.target.value })} className="h-7 text-[0.78rem]" />
          {draft.kind === "chat" ? <p className="text-[0.68rem] text-muted-foreground">Links the Bot’s main chat. A link is a declaration; Chat focus is set in Resources.</p> : null}
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" disabled={request.running} onClick={() => { request.clear(); setDraft(null); }}>Cancel</Button>
            <Button type="submit" size="xs" disabled={!target || locked}>{request.running ? <Spinner data-icon="inline-start" /> : null}Add link</Button>
          </div>
        </form>
      ) : null}
      <RequestNotice request={request} conflict={<ConflictNote request={request} />} />
    </Section>
  );
}

function Labels({ item, readOnly }: { item: WorkItem; readOnly: string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const request = useHudRequest(() => setDraft(null));
  const locked = request.running || request.held;
  return (
    <Section title="Labels" aside={!readOnly && draft === null ? <Button size="xs" variant="ghost" onClick={() => setDraft(item.labels.join(", "))}><PencilIcon data-icon="inline-start" />Edit</Button> : undefined}>
      {draft === null ? (
        item.labels.length ? (
          <div className="flex flex-wrap gap-1">{item.labels.map((label) => <span key={label} className="rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem]">{label}</span>)}</div>
        ) : <p className="px-0.5 text-[0.72rem] text-muted-foreground">No labels.</p>
      ) : (
        <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); if (!locked) void request.submit("work_update", { id: item.id, expectedRevision: item.revision, patch: { labels: parseLabels(draft) } }); }}>
          <Input autoFocus value={draft} disabled={locked} placeholder="comma, separated" aria-label="Labels" onChange={(event) => setDraft(event.target.value)} className="h-7 flex-1 text-[0.78rem]" />
          <Button type="button" size="xs" variant="ghost" onClick={() => { request.clear(); setDraft(null); }}>Cancel</Button>
          <Button type="submit" size="xs" disabled={locked}>Save</Button>
        </form>
      )}
      <RequestNotice request={request} conflict={<ConflictNote request={request} />} />
    </Section>
  );
}

type MetadataRead = { id: string; revision: number; namespaces: Record<string, Record<string, unknown>> };

/**
 * Agent coordination metadata, read only when a person opens it. It stays out of the
 * normal view and the page snapshot. It is coordination data, not a secret store.
 */
function Metadata({ item, readOnly }: { item: WorkItem; readOnly: string | null }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<{ data: MetadataRead | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const [edit, setEdit] = useState<{ namespace: string; text: string; fresh: boolean } | null>(null);
  const request = useHudRequest(() => { setEdit(null); void load(); });
  const load = async () => {
    setRead((current) => ({ ...current, loading: true }));
    try { setRead({ data: await store.call<MetadataRead>("hud", "work_metadata_get", { id: item.id }), error: null, loading: false }); }
    catch (error) { setRead((current) => ({ data: current.data, error: error instanceof Error ? error.message : String(error), loading: false })); }
  };
  // Re-read while open when the item's revision moves; metadata writes advance it.
  useEffect(() => { if (open) void load(); }, [open, item.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  let parsed: Record<string, unknown> | null | undefined;
  if (edit) { try { const value = JSON.parse(edit.text); parsed = value && typeof value === "object" && !Array.isArray(value) ? value : undefined; } catch { parsed = undefined; } }
  const validName = edit ? /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(edit.namespace) : false;
  const save = (value: Record<string, unknown> | null, namespace: string) => read.data &&
    void request.submit("work_metadata_set", { id: item.id, expectedRevision: read.data.revision, namespace, value });
  const locked = Boolean(readOnly) || request.running || request.held;
  return (
    <details className="group/meta rounded-lg border border-dashed" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground">
        <BracesIcon aria-hidden className="size-3.5" />Agent metadata
        <span className="ml-auto text-[0.66rem]">read only when open</span>
      </summary>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-dashed p-2.5">
          <p className="text-[0.68rem] text-pretty text-muted-foreground">Namespaced JSON agents use for correlation. Not shown in summaries or history, and not a place for secrets.</p>
          {read.loading && !read.data ? <p className="text-[0.72rem] text-muted-foreground">Reading…</p> : null}
          {read.error ? <p className="text-[0.72rem] text-destructive">{read.error}</p> : null}
          {read.data ? (
            Object.keys(read.data.namespaces).length ? (
              <ul className="flex flex-col gap-1.5">
                {Object.entries(read.data.namespaces).map(([namespace, value]) => (
                  <li key={namespace} className="flex flex-col gap-1 rounded-md bg-muted/50 p-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[0.72rem] font-medium">{namespace}</span>
                      <CopyButton value={JSON.stringify(value, null, 2)} label={`${namespace} JSON`} className="opacity-100" />
                      {!readOnly ? (
                        <>
                          <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label={`Edit ${namespace}`} disabled={locked} onClick={() => setEdit({ namespace, text: JSON.stringify(value, null, 2), fresh: false })}><PencilIcon /></Button>
                          <Button size="icon-xs" variant="ghost" aria-label={`Remove ${namespace}`} disabled={locked} onClick={() => save(null, namespace)}><Trash2Icon /></Button>
                        </>
                      ) : null}
                    </div>
                    <pre className="max-h-40 overflow-auto font-mono text-[0.68rem] whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[0.72rem] text-muted-foreground">No namespaces.</p>
          ) : null}
          {edit ? (
            <form className="flex flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); if (parsed && validName && !locked) save(parsed, edit.namespace); }}>
              <Input value={edit.namespace} disabled={!edit.fresh || locked} placeholder="namespace" aria-label="Namespace" onChange={(event) => setEdit({ ...edit, namespace: event.target.value })} className="h-7 font-mono text-[0.75rem]" />
              <Textarea value={edit.text} disabled={locked} rows={6} aria-label="Namespace JSON object" onChange={(event) => setEdit({ ...edit, text: event.target.value })} className="font-mono text-[0.72rem]" />
              {parsed === undefined ? <p className="text-[0.68rem] text-destructive">Enter one JSON object. Null and empty values inside it are kept.</p> : null}
              <div className="flex justify-end gap-1.5">
                <Button type="button" size="xs" variant="ghost" onClick={() => { request.clear(); setEdit(null); }}>Cancel</Button>
                <Button type="submit" size="xs" disabled={!parsed || !validName || locked}>{request.running ? <Spinner data-icon="inline-start" /> : null}Replace namespace</Button>
              </div>
            </form>
          ) : !readOnly ? (
            <Button size="xs" variant="ghost" className="self-start" disabled={locked || !read.data} onClick={() => setEdit({ namespace: "", text: "{\n  \n}", fresh: true })}><PlusIcon data-icon="inline-start" />New namespace</Button>
          ) : null}
          <RequestNotice request={request} conflict={
            <p role="alert" className="rounded-lg bg-warning/10 px-2.5 py-2 text-[0.72rem] text-pretty text-warning">
              The item changed since metadata was read; it has been read again. Your edit is kept: review it and replace again. <button type="button" className="underline underline-offset-2" onClick={() => { request.clear(); void load(); }}>Dismiss</button>
            </p>
          } />
        </div>
      ) : null}
    </details>
  );
}
