"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ActivityIcon, BotIcon, ChevronRightIcon, CircleCheckIcon, CircleHelpIcon, CircleXIcon, FileSearchIcon, HistoryIcon, InboxIcon, MessageSquarePlusIcon,
  MessagesSquareIcon, RadarIcon, RefreshCwIcon, RotateCcwIcon, SquareTerminalIcon, UserIcon } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountLabels, shortId } from "@/lib/stack/derive";
import { conversationLabel, evidenceSegments, isMainThread, jobCounts, pairInterpretations, parseConversation, queueOrder, readChunks, readEventKinds,
  resolvedStates, signalErrorText, unresolvedStates, type ItemPair } from "@/lib/stack/signal";
import type { AttentionAudience, AttentionChunk, AttentionEvent, AttentionFeedback, AttentionFeedbackKind, AttentionItem, AttentionItemState, AttentionMessage,
  AttentionModels, AttentionPage, AttentionRun, InferEffort, InferModel, InferRequest } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { CopyButton, Empty, NodeCard, NodeLink, NodeTitle, Row, StatusDot, Time, type Tone } from "./primitives";
import { useChatWindows, useStack, useStore, useWorkbench } from "./provider";
import { Section, Window } from "./window";

const labelClass = "px-0.5 text-[0.7rem] font-medium text-muted-foreground";
const metaClass = "font-mono text-[0.65rem] text-pretty text-muted-foreground";
const pageSize = 25;

// ——— Data hooks ———————————————————————————————————————————————————————————

type Feed<T> = { key: string; entries: T[]; nextCursor: number; hasMore: boolean };

/**
 * A newest-first Signal list. Each record generation re-reads the newest page;
 * older pages the reader loaded stay below it unless new records left a gap.
 */
function useSignalFeed<T extends { cursor: number }>(name: string, filters: Record<string, unknown>, enabled = true) {
  const store = useStore();
  const { signalGeneration, status } = useStack();
  const open = status.signal === "open";
  const key = JSON.stringify(filters);
  const [feed, setFeed] = useState<Feed<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    if (!open || !enabled) return;
    let live = true;
    store.readSignal<AttentionPage<T>>(name, { ...JSON.parse(key), order: "desc", limit: pageSize }).then((page) => {
      if (!live) return;
      setError(null);
      setFeed((current) => {
        const oldest = page.entries.at(-1)?.cursor ?? Number.POSITIVE_INFINITY;
        const same = current?.key === key && current.entries.length > 0;
        const gap = same && page.hasMore && oldest > current.entries[0]!.cursor;
        if (!same || gap) return { key, ...page };
        const older = current.entries.filter((entry) => entry.cursor < oldest);
        return { key, entries: [...page.entries, ...older], nextCursor: older.length ? current.nextCursor : page.nextCursor, hasMore: older.length ? current.hasMore : page.hasMore };
      });
    }, (cause) => { if (live) setError(signalErrorText(errorMessage(cause))); });
    return () => { live = false; };
  }, [store, name, key, signalGeneration, open, enabled]);
  const current = feed?.key === key ? feed : null;
  const more = useCallback(() => {
    if (!current?.hasMore) return;
    setLoadingMore(true);
    store.readSignal<AttentionPage<T>>(name, { ...JSON.parse(key), order: "desc", limit: pageSize, before: current.nextCursor }).then(
      (page) => setFeed((latest) => latest?.key === key ? { key, entries: [...latest.entries, ...page.entries.filter((entry) => entry.cursor < (latest.entries.at(-1)?.cursor ?? Infinity))], nextCursor: page.nextCursor, hasMore: page.hasMore } : latest),
      (cause) => setError(signalErrorText(errorMessage(cause))),
    ).finally(() => setLoadingMore(false));
  }, [store, name, key, current]);
  return { entries: current?.entries ?? null, hasMore: current?.hasMore ?? false, more, loadingMore, error };
}

/** Every matching record, oldest first, re-read on each record generation. Open requests stay few; the cap keeps a runaway bounded. */
function useSignalAll<T>(name: string, filters: Record<string, unknown>, maxPages = 8) {
  const store = useStore();
  const { signalGeneration, status } = useStack();
  const open = status.signal === "open";
  const key = JSON.stringify(filters);
  const [result, setResult] = useState<{ key: string; entries: T[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const entries: T[] = [];
      let after = 0;
      for (let page = 0; page < maxPages; page++) {
        const read = await store.readSignal<AttentionPage<T>>(name, { ...JSON.parse(key), after, limit: pageSize });
        entries.push(...read.entries);
        after = read.nextCursor;
        if (!read.hasMore) return { entries, truncated: false };
      }
      return { entries, truncated: true };
    })().then((read) => { if (live) { setError(null); setResult({ key, ...read }); } }, (cause) => { if (live) setError(signalErrorText(errorMessage(cause))); });
    return () => { live = false; };
  }, [store, name, key, signalGeneration, open, maxPages]);
  const current = result?.key === key ? result : null;
  return { entries: current?.entries ?? null, truncated: current?.truncated ?? false, error };
}

/** One read keyed by `key`, repeated on each record generation. */
function useSignalRead<T>(key: string | null, read: () => Promise<T>) {
  const { signalGeneration, status } = useStack();
  const open = status.signal === "open";
  const [value, setValue] = useState<{ key: string; data: T } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  // `read` is recreated each render; the key names what it reads.
  const run = useCallback(read, [key]);
  useEffect(() => {
    if (!key || !open) return;
    let live = true;
    run().then((data) => { if (live) { setValue({ key, data }); setError(null); } }, (cause) => { if (live) setError({ key, message: signalErrorText(errorMessage(cause)) }); });
    return () => { live = false; };
  }, [key, run, signalGeneration, open]);
  return { data: value?.key === key ? value.data : null, error: error?.key === key ? error.message : null };
}

function MoreButton({ feed }: { feed: { hasMore: boolean; more(): void; loadingMore: boolean } }) {
  if (!feed.hasMore) return null;
  return (
    <Button type="button" size="xs" variant="ghost" className="self-center text-muted-foreground" disabled={feed.loadingMore} onClick={feed.more}>
      {feed.loadingMore ? <Spinner data-icon="inline-start" /> : null}Show older
    </Button>
  );
}

// ——— Shared presentation ————————————————————————————————————————————————————

const reasonTone: Record<string, string> = {
  action: "bg-destructive/10 text-destructive",
  response: "bg-warning/15 text-warning",
  review: "bg-pkg-codex/15 text-pkg-codex",
  awareness: "bg-muted text-muted-foreground",
  none: "bg-muted text-muted-foreground",
};

const stateTone: Record<AttentionItemState, Tone> = {
  open: "warning", partial: "warning", unclear: "warning", informational: "muted",
  answered: "success", satisfied: "success", declined: "muted", withdrawn: "muted", superseded: "muted",
};

function Chip({ className, children, title }: { className?: string; children: React.ReactNode; title?: string }) {
  return <span title={title} className={cn("inline-flex h-4.5 items-center rounded-md px-1.5 text-[0.62rem] font-semibold tracking-wide uppercase", className)}>{children}</span>;
}

const runStateView: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
  running: { label: "Running", icon: <Spinner className="size-3" />, className: "text-muted-foreground" },
  completed: { label: "Completed", icon: <CircleCheckIcon className="size-3" />, className: "text-success" },
  failed: { label: "Failed", icon: <CircleXIcon className="size-3" />, className: "text-destructive" },
  unknown: { label: "Outcome unknown", icon: <CircleHelpIcon className="size-3" />, className: "text-warning" },
};

function runView(state: string) {
  return runStateView[state] ?? { label: state, icon: <CircleHelpIcon className="size-3" />, className: "text-muted-foreground" };
}

function duration(run: AttentionRun): string | null {
  return run.finished ? `${((run.finished - run.at) / 1_000).toFixed(1)}s` : null;
}

/** A Bot conversation's home: its Fleet chat for the main thread, else the Bot card; Worker transcripts have no view. */
function ConversationLink({ conversation }: { conversation: string }) {
  const { bots } = useStack();
  const ref = parseConversation(conversation);
  const label = conversationLabel(conversation, bots.data);
  if (ref.kind !== "bot" || !bots.data?.some((bot) => bot.id === ref.botId)) return <span className="truncate">{label}</span>;
  return <NodeLink node={{ kind: "bot", id: ref.botId }} label={ref.botId} className="truncate">{label}</NodeLink>;
}

function OpenChatButton({ conversation }: { conversation: string }) {
  const { bots } = useStack();
  const { chats } = useChatWindows();
  const { goTo } = useWorkbench();
  const ref = parseConversation(conversation);
  if (ref.kind !== "bot" || !isMainThread(conversation, bots.data)) return null;
  return (
    <Button type="button" size="xs" variant="outline" title="Answer in the Bot's chat; replies resolve requests"
      onClick={(event) => goTo({ kind: "chat", id: event.metaKey || event.ctrlKey || event.shiftKey ? chats.open(ref.botId) : chats.show(ref.botId) })}>
      <SquareTerminalIcon data-icon="inline-start" />Open chat
    </Button>
  );
}

function feedbackAuthor(): string {
  try { return window.localStorage.getItem("agentstack.uix.signal.author.v1") || "human"; } catch { return "human"; }
}

/** Attributed evaluation evidence. The key is fixed while the dialog is open, so a retried submission never records twice. */
function FeedbackDialog({ open, onOpenChange, messageId, runId, subject }: { open: boolean; onOpenChange(open: boolean): void; messageId: string; runId: string | null; subject: string }) {
  const store = useStore();
  const { remote } = useStack();
  const formId = useId();
  const [id, setId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<AttentionFeedbackKind>("correction");
  const [author, setAuthor] = useState("human");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setId(crypto.randomUUID());
    setAuthor(feedbackAuthor());
    setBody("");
    setError(null);
  }, [open]);
  const submit = async () => {
    if (!body.trim() || !author.trim()) return;
    setPending(true);
    setError(null);
    try {
      await store.signalAction("attention_feedback", { id, messageId, ...(runId ? { runId } : {}), kind, author: author.trim(), body: body.trim() });
      try { window.localStorage.setItem("agentstack.uix.signal.author.v1", author.trim()); } catch { /* optional persistence */ }
      toast.success("Feedback recorded");
      onOpenChange(false);
    } catch (cause) {
      setError(signalErrorText(errorMessage(cause)));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Feedback</DialogTitle>
          <DialogDescription className="text-pretty">On {subject}. Feedback is evaluation evidence: it does not resolve anything or retrain the model.</DialogDescription>
        </DialogHeader>
        <form id={formId} className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${formId}-kind`} className={labelClass}>Kind</label>
              <NativeSelect id={`${formId}-kind`} className="w-full" value={kind} onChange={(event) => setKind(event.target.value as AttentionFeedbackKind)}>
                <NativeSelectOption value="correction">Correction</NativeSelectOption>
                <NativeSelectOption value="label">Label</NativeSelectOption>
                <NativeSelectOption value="outcome">Outcome</NativeSelectOption>
                <NativeSelectOption value="behavior">Behavior</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${formId}-author`} className={labelClass}>Author</label>
              <Input id={`${formId}-author`} value={author} maxLength={200} onChange={(event) => setAuthor(event.target.value)} className="h-8" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-body`} className={labelClass}>Note</label>
            <Textarea id={`${formId}-body`} value={body} maxLength={32_000} placeholder="What was right or wrong about this interpretation?"
              onChange={(event) => setBody(event.target.value)} className="min-h-24" />
          </div>
          {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form={formId} disabled={pending || !body.trim() || !author.trim() || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined}>
            {pending ? <Spinner data-icon="inline-start" /> : null}{error ? "Retry" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ——— Signal: processing, backlog and defaults ——————————————————————————————————

const jobOrder: Array<{ state: string; label: string; className: string }> = [
  { state: "running", label: "running", className: "bg-pkg-codex" },
  { state: "pending", label: "pending", className: "bg-warning" },
  { state: "completed", label: "completed", className: "bg-success/70" },
  { state: "failed", label: "failed", className: "bg-destructive" },
  { state: "unknown", label: "unknown", className: "bg-warning/50" },
  { state: "superseded", label: "superseded", className: "bg-muted-foreground/30" },
];

/** Processing control, health, backlog and the inference defaults later interpretations use. */
export function SignalWindow() {
  const store = useStore();
  const { signalStatus, status, endpoints, remote } = useStack();
  const data = signalStatus.data;
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = status.signal === "open";
  const counts = jobCounts(data);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const other = Object.entries(counts).filter(([state]) => !jobOrder.some((item) => item.state === state));

  const control = async (enabled: boolean) => {
    setPending(true);
    setError(null);
    try {
      await store.signalAction("attention_control", { enabled });
    } catch (cause) {
      setError(signalErrorText(errorMessage(cause)));
    } finally {
      setPending(false);
    }
  };

  const phase = !data ? null : !data.enabled ? "Paused" : !data.baselined ? "Establishing baselines…" : "Interpreting new messages";
  const inference = data?.lastInference;
  return (
    <Window id="signal" title="Signal" icon={RadarIcon} accent="events" node={{ kind: "signal" }}
      status={status.signal} endpoint={endpoints.signal} updatedAt={signalStatus.at} error={signalStatus.error} empty={!data}>
      {data ? (
        <>
          <div className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
            <StatusDot tone={data.enabled ? data.baselined ? "success" : "info" : "muted"} pulse={data.enabled && (counts.running ?? 0) > 0} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{phase}</span>
              <span className="text-[0.68rem] text-pretty text-muted-foreground">
                {data.enabled ? "Spends Codex allowance for each new message" : data.activatedAt ? "Checkpoints kept; resuming catches up" : "Not started; nothing has been interpreted"}
              </span>
            </div>
            {pending ? <Spinner /> : null}
            <Switch checked={data.enabled} disabled={!connected || pending || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined} aria-label="Interpret new messages"
              onCheckedChange={(checked) => { if (checked) setConfirm(true); else void control(false); }} />
          </div>
          {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
          <dl className="flex flex-col">
            <Row label="Baselines">{data.baselined ? "established" : data.activatedAt ? "pending" : "not started"}</Row>
            <Row label="Last scan"><Time at={data.lastScan} /></Row>
            <Row label="Last interpretation">
              {inference?.at ? (
                <span className={cn("inline-flex items-center gap-1", inference.error ? "text-destructive" : undefined)}>
                  {inference.runId ? <NodeLink node={{ kind: "attention-run", id: inference.runId }} label="run">{inference.error ? "failed" : inference.state ?? "run"}</NodeLink> : inference.error ? "failed" : inference.state}
                  <span className="text-muted-foreground">·</span><Time at={inference.at} className="text-muted-foreground" />
                </span>
              ) : "never"}
            </Row>
            {inference?.error ? <p className="-mt-0.5 mb-1 text-right text-[0.68rem] text-pretty text-destructive">{signalErrorText(inference.error)}</p> : null}
            <Row label="Messages captured">{data.messages.toLocaleString()}</Row>
            <Row label="Runs">{data.runs.toLocaleString()}</Row>
          </dl>
          {total ? (
            <Section title="Backlog">
              <span className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={jobOrder.map((item) => `${counts[item.state] ?? 0} ${item.label}`).join(", ")}>
                {jobOrder.map((item) => counts[item.state] ? <span key={item.state} className={item.className} style={{ width: `${(counts[item.state]! / total) * 100}%` }} /> : null)}
              </span>
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 px-0.5 text-[0.68rem] text-muted-foreground tabular-nums">
                {jobOrder.map((item) => counts[item.state] ? (
                  <span key={item.state} className="inline-flex items-center gap-1"><span className={cn("size-1.5 rounded-full", item.className)} />{counts[item.state]} {item.label}</span>
                ) : null)}
                {other.map(([state, count]) => <span key={state}>{count} {state}</span>)}
              </p>
            </Section>
          ) : null}
          {data.sourceErrors.length ? (
            <Section title="Unreadable sources">
              <ul className="flex flex-col gap-1">
                {data.sourceErrors.map((item) => (
                  <li key={item.source} className="flex flex-col rounded-lg bg-destructive/5 px-2 py-1.5 text-[0.72rem]">
                    <span className="font-mono text-[0.68rem]">{item.source}</span>
                    <span className="text-pretty text-destructive">{item.error}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <DefaultsSection />
        </>
      ) : <Empty icon={RadarIcon} title={signalStatus.error ? "Signal unavailable" : "Reading Signal…"} />}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{data?.activatedAt ? "Resume interpretation?" : "Start interpreting new messages?"}</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {data?.activatedAt
                ? "Messages that arrived while paused are caught up. Each one spends Codex allowance on the default account."
                : "First enable records where each Bot chat and Worker transcript is now; existing messages are not interpreted. Each new message spends Codex allowance on the default account."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => { setConfirm(false); void control(true); }}>{data?.activatedAt ? "Resume" : "Start"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Window>
  );
}

/** Revision-fenced model, effort and account for later runs. Choices come from the account's own catalog; nothing here runs inference. */
function DefaultsSection() {
  const store = useStore();
  const formId = useId();
  const { signalStatus, status, accounts, inferModels, remote } = useStack();
  const settings = signalStatus.data?.settings;
  const labels = accountLabels(accounts.data);
  const [draft, setDraft] = useState<{ revision: number; model: string; reasoningEffort: InferEffort; accountId: string | null } | null>(null);
  const [models, setModels] = useState<AttentionModels | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = status.signal === "open";
  const discover = useCallback(() => {
    setDiscovering(true);
    setModelsError(null);
    store.call<AttentionModels>("signal", "attention_models").then(setModels, (cause) => setModelsError(signalErrorText(errorMessage(cause)))).finally(() => setDiscovering(false));
  }, [store]);
  useEffect(() => { if (connected) discover(); }, [connected, discover]);
  if (!settings) return null;
  // An edit is kept only against the revision it started from.
  const current = draft && draft.revision === settings.revision ? draft : { ...settings };
  const dirty = current.model !== settings.model || current.reasoningEffort !== settings.reasoningEffort || current.accountId !== settings.accountId;
  // The effective account's catalog, or infer's cached catalog for a different chosen account.
  const choiceAccount = current.accountId ?? models?.accountId ?? null;
  const offered: InferModel[] = (models && models.accountId === choiceAccount ? models.models : inferModels.data?.find((item) => item.accountId === choiceAccount)?.models) ?? [];
  const chosen = offered.find((item) => item.id === current.model);
  const efforts = chosen?.supportedEfforts ?? [current.reasoningEffort];
  const update = (patch: Partial<typeof current>) => setDraft({ ...current, ...patch, revision: settings.revision });
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await store.signalAction("attention_defaults_set", { model: current.model, reasoningEffort: current.reasoningEffort, accountId: current.accountId, expectedRevision: settings.revision });
      setDraft(null);
    } catch (cause) {
      setError(signalErrorText(errorMessage(cause)));
      if (/attention_settings_conflict/.test(errorMessage(cause))) setDraft(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section title="Defaults" aside={
      <Tooltip>
        <TooltipTrigger render={<Button type="button" size="icon-xs" variant="ghost" aria-label="Read model choices again" disabled={!connected || discovering} onClick={discover} />}>
          {discovering ? <Spinner /> : <RefreshCwIcon />}
        </TooltipTrigger>
        <TooltipContent side="bottom">Read model choices again</TooltipContent>
      </Tooltip>
    }>
      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${formId}-account`} className={labelClass}>Account</label>
          <NativeSelect id={`${formId}-account`} className="w-full" value={current.accountId ?? ""} onChange={(event) => update({ accountId: event.target.value || null })}>
            <NativeSelectOption value="">First available{models && !settings.accountId ? ` (now ${labels.get(models.accountId) ?? shortId(models.accountId)})` : ""}</NativeSelectOption>
            {(accounts.data ?? []).map((account) => (
              <NativeSelectOption key={account.id} value={account.id} disabled={(!account.enabled || account.removing) && account.id !== current.accountId}>
                {labels.get(account.id) ?? shortId(account.id)}{account.removing ? " · removing" : !account.enabled ? " · disabled" : ""}
              </NativeSelectOption>
            ))}
            {current.accountId && !accounts.data?.some((account) => account.id === current.accountId) ? <NativeSelectOption value={current.accountId}>{shortId(current.accountId)} · missing</NativeSelectOption> : null}
          </NativeSelect>
        </div>
        <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-1.5">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${formId}-model`} className={labelClass}>Model</label>
            <NativeSelect id={`${formId}-model`} className="w-full" value={current.model}
              onChange={(event) => { const next = offered.find((item) => item.id === event.target.value); update({ model: event.target.value, ...(next && !next.supportedEfforts.includes(current.reasoningEffort) ? { reasoningEffort: next.defaultEffort } : {}) }); }}>
              {chosen ? null : <NativeSelectOption value={current.model}>{current.model}{offered.length ? " (not offered)" : ""}</NativeSelectOption>}
              {offered.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.id}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${formId}-effort`} className={labelClass}>Effort</label>
            <NativeSelect id={`${formId}-effort`} className="w-full" value={current.reasoningEffort} onChange={(event) => update({ reasoningEffort: event.target.value as InferEffort })}>
              {efforts.includes(current.reasoningEffort) ? null : <NativeSelectOption value={current.reasoningEffort}>{current.reasoningEffort}</NativeSelectOption>}
              {efforts.map((level) => <NativeSelectOption key={level} value={level}>{level}{level === chosen?.defaultEffort ? " (default)" : ""}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        </div>
        <p role="status" className="px-0.5 text-[0.68rem] text-pretty text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span>
            : modelsError && !offered.length ? <span className="text-destructive">{modelsError}</span>
            : !offered.length && choiceAccount ? "No model choices observed for this account; discover them in Lab › Inference."
            : `Applies to later interpretations; existing runs keep their settings. Revision ${settings.revision}.`}
        </p>
        {dirty ? (
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
            <Button type="submit" size="xs" disabled={saving || !connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined}>{saving ? <Spinner data-icon="inline-start" /> : null}Save defaults</Button>
          </div>
        ) : null}
      </form>
    </Section>
  );
}

// ——— Attention: the queue ——————————————————————————————————————————————————————

type StateFilter = "attention" | "resolved" | "informational" | "all";
const stateFilters: Array<[StateFilter, string]> = [["attention", "Needs attention"], ["resolved", "Resolved"], ["informational", "Informational"], ["all", "All"]];
const asksSomething = new Set(["review", "response", "action"]);

/** Current requests for attention. Answering happens in the conversation; this view never marks anything done. */
export function AttentionWindow() {
  const { status, endpoints, signalStatus, bots } = useStack();
  const formId = useId();
  const [state, setState] = useState<StateFilter>("attention");
  const [audience, setAudience] = useState<AttentionAudience | "">("human");
  const [botId, setBotId] = useState("");
  const [fyi, setFyi] = useState(false);
  const filters = { ...(audience ? { audience } : {}), ...(botId ? { botId } : {}) };
  const queue = useSignalAll<AttentionItem>("attention_list", { ...filters, states: unresolvedStates });
  const history = useSignalFeed<AttentionItem>("attention_list", { ...filters, ...(state === "resolved" ? { states: resolvedStates } : state === "informational" ? { state: "informational" } : {}) }, state !== "attention");
  const aware = useSignalFeed<AttentionItem>("attention_list", { ...filters, state: "informational", reason: "awareness" }, state === "attention" && fyi);
  const asks = useMemo(() => (queue.entries ?? []).filter((item) => asksSomething.has(item.attention.reason)).sort(queueOrder), [queue.entries]);
  const quiet = useMemo(() => (queue.entries ?? []).filter((item) => !asksSomething.has(item.attention.reason)), [queue.entries]);
  const list = state === "attention" ? asks : history.entries ?? [];
  const error = state === "attention" ? queue.error : history.error;
  const loading = state === "attention" ? queue.entries === null : history.entries === null;
  return (
    <Window id="attention" title="Attention" icon={InboxIcon} accent="events" count={state === "attention" ? asks.length || null : null}
      status={status.signal} endpoint={endpoints.signal} updatedAt={signalStatus.at} error={error}>
      <div className="flex flex-wrap items-center gap-1.5">
        <NativeSelect size="sm" aria-label="State" value={state} onChange={(event) => setState(event.target.value as StateFilter)}>
          {stateFilters.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Audience" id={`${formId}-audience`} value={audience} onChange={(event) => setAudience(event.target.value as AttentionAudience | "")}>
          <NativeSelectOption value="human">For a human</NativeSelectOption>
          <NativeSelectOption value="agent">For an agent</NativeSelectOption>
          <NativeSelectOption value="team">For a team</NativeSelectOption>
          <NativeSelectOption value="unspecified">Unspecified audience</NativeSelectOption>
          <NativeSelectOption value="">Any audience</NativeSelectOption>
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Bot" value={botId} onChange={(event) => setBotId(event.target.value)}>
          <NativeSelectOption value="">All Bots</NativeSelectOption>
          {(bots.data ?? []).map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{bot.id}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {loading ? (
        <p className="text-[0.72rem] text-muted-foreground">{error ?? "Reading…"}</p>
      ) : list.length ? (
        <ul className="flex flex-col gap-2">
          {list.map((item) => <li key={item.id}><AttentionCard item={item} /></li>)}
        </ul>
      ) : (
        <Empty icon={InboxIcon} title={state === "attention" ? "Nothing needs attention" : "No items"} />
      )}
      {state === "attention" && queue.truncated ? <p className="text-[0.68rem] text-warning">Showing the oldest {queue.entries?.length} open items.</p> : null}
      {state !== "attention" ? <MoreButton feed={history} /> : null}
      {state === "attention" ? (
        <div className="flex flex-col gap-2">
          <button type="button" aria-expanded={fyi} onClick={() => setFyi(!fyi)}
            className="flex items-center gap-1 self-start rounded-sm px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <ChevronRightIcon className={cn("size-3 transition-transform", fyi && "rotate-90")} />For your information{quiet.length ? ` · ${quiet.length} open` : ""}
          </button>
          {fyi ? (
            <ul className="flex flex-col gap-2">
              {[...quiet, ...(aware.entries ?? [])].map((item) => <li key={item.id}><AttentionCard item={item} quiet /></li>)}
              {!quiet.length && aware.entries?.length === 0 ? <li className="px-0.5 text-[0.72rem] text-muted-foreground">No awareness items.</li> : null}
              <MoreButton feed={aware} />
            </ul>
          ) : null}
        </div>
      ) : null}
    </Window>
  );
}

function AttentionCard({ item, quiet = false }: { item: AttentionItem; quiet?: boolean }) {
  const { select } = useWorkbench();
  const { signalRecords, remote } = useStack();
  const [feedback, setFeedback] = useState(false);
  const inferred = item.attention.basis === "inferred";
  const reason = item.attention.reason;
  return (
    <NodeCard node={{ kind: "attention-item", id: item.id }} label={item.summary} className={cn(quiet && "bg-background/30")}>
      <div className="flex flex-wrap items-center gap-1">
        <Chip className={reasonTone[reason]} title={item.attention.rationale}>{reason}</Chip>
        {item.timing.urgency !== "unspecified" && item.timing.urgency !== "routine" ? (
          <Chip className={item.timing.urgency === "immediate" ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning"}>{item.timing.urgency}</Chip>
        ) : null}
        <span className={cn("text-[0.65rem]", inferred ? "text-muted-foreground/70 italic" : "text-muted-foreground")} title={item.attention.rationale}>{item.attention.basis}</span>
        <span className="ml-auto flex items-center gap-1 text-[0.65rem] text-muted-foreground">
          <StatusDot tone={stateTone[item.state]} />{item.state}
        </span>
      </div>
      <NodeTitle node={{ kind: "attention-item", id: item.id }} label={item.summary} className={cn("text-sm font-medium text-pretty", inferred && "text-foreground/80")}>
        {item.summary}
      </NodeTitle>
      <blockquote className="line-clamp-2 border-l-2 pl-2 text-[0.75rem] text-pretty text-muted-foreground">“{item.evidence.quote}”</blockquote>
      <p className={metaClass}>
        {item.engagement.length ? `→ ${item.engagement.join(" · ")} · ` : ""}
        for {item.audience.kind}{item.audience.id ? ` ${item.audience.id}` : ""}
        {item.timing.deadline ? ` · by ${item.timing.deadline}` : ""}
      </p>
      {item.timing.blockingScope ? <p className="text-[0.72rem] text-pretty"><span className="text-muted-foreground">Blocks</span> {item.timing.blockingScope}</p> : null}
      {item.conditions.length || item.uncertainty.length ? (
        <ul className="flex flex-col gap-0.5 text-[0.72rem] text-pretty">
          {item.conditions.map((text, index) => <li key={`c${index}`}><span className="text-muted-foreground">If</span> {text}</li>)}
          {item.uncertainty.map((text, index) => <li key={`u${index}`} className="text-warning">? {text}</li>)}
        </ul>
      ) : null}
      {item.relations.length ? (
        <ul className="flex flex-col gap-0.5 text-[0.7rem] text-muted-foreground">
          {item.relations.map((relation, index) => {
            const target = relation.targetId ? signalRecords.items[relation.targetId] : undefined;
            return (
              <li key={index} className="truncate">
                {relation.type.replace("_", " ")}{" "}
                {relation.targetId ? (
                  <button type="button" className="text-foreground/80 underline-offset-4 hover:underline" onClick={() => select({ kind: "attention-item", id: relation.targetId! })}>
                    {target?.summary ?? relation.referenceText}
                  </button>
                ) : relation.referenceText}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[0.68rem] text-muted-foreground"><ConversationLink conversation={item.conversation} /></span>
        <OpenChatButton conversation={item.conversation} />
        <Button type="button" size="xs" variant="ghost" onClick={() => select({ kind: "attention-message", id: item.messageId })}><FileSearchIcon data-icon="inline-start" />Source</Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => select({ kind: "attention-run", id: item.runId })}><HistoryIcon data-icon="inline-start" />Trace</Button>
        <Button type="button" size="xs" variant="ghost" disabled={remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => setFeedback(true)}><MessageSquarePlusIcon data-icon="inline-start" />Feedback</Button>
      </div>
      <FeedbackDialog open={feedback} onOpenChange={setFeedback} messageId={item.messageId} runId={item.runId} subject={`“${item.summary}”`} />
    </NodeCard>
  );
}

// ——— Messages: captured source ————————————————————————————————————————————————————

/** Captured message revisions, newest first. A message's name inspects its full text and evidence. */
export function AttentionMessagesWindow() {
  const { status, endpoints, signalStatus, bots } = useStack();
  const [botId, setBotId] = useState("");
  const [superseded, setSuperseded] = useState(false);
  const feed = useSignalFeed<AttentionMessage>("attention_message_list", botId ? { botId } : {});
  const shown = (feed.entries ?? []).filter((message) => superseded || message.current);
  return (
    <Window id="attention-messages" title="Messages" icon={MessagesSquareIcon} accent="events" status={status.signal} endpoint={endpoints.signal}
      updatedAt={signalStatus.at} error={feed.error} count={signalStatus.data?.messages || null}>
      <div className="flex flex-wrap items-center gap-1.5">
        <NativeSelect size="sm" aria-label="Bot" value={botId} onChange={(event) => setBotId(event.target.value)}>
          <NativeSelectOption value="">All sources</NativeSelectOption>
          {(bots.data ?? []).map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{bot.id}</NativeSelectOption>)}
        </NativeSelect>
        <label className="ml-auto flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <Switch size="sm" checked={superseded} onCheckedChange={setSuperseded} />Superseded revisions
        </label>
      </div>
      {feed.entries === null ? <p className="text-[0.72rem] text-muted-foreground">{feed.error ?? "Reading…"}</p>
        : shown.length ? (
          <ul className="flex flex-col gap-1.5">
            {shown.map((message) => <li key={message.id}><MessageRow message={message} /></li>)}
          </ul>
        ) : <Empty icon={MessagesSquareIcon} title="No captured messages" />}
      <MoreButton feed={feed} />
    </Window>
  );
}

function authorLabel(message: Pick<AttentionMessage, "role" | "authorKind">): string {
  return message.role === "assistant" ? "Assistant" : message.authorKind === "human" ? "Human" : message.authorKind === "agent" ? "Agent prompt" : "User (origin unknown)";
}

function MessageRow({ message }: { message: AttentionMessage }) {
  const node = { kind: "attention-message", id: message.id } as const;
  const Icon = message.role === "assistant" ? BotIcon : UserIcon;
  return (
    <NodeCard node={node} label={authorLabel(message)} variant="row" className={cn(!message.current && "opacity-60")}>
      <div className="flex items-center gap-1.5 text-[0.7rem]">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <NodeTitle node={node} label={`${authorLabel(message)} message`} className="font-medium">{authorLabel(message)}</NodeTitle>
        <span className="min-w-0 truncate text-muted-foreground"><ConversationLink conversation={message.conversation} /></span>
        <Time at={message.observedAt} className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground" />
      </div>
      <p className="line-clamp-3 text-[0.78rem] text-pretty whitespace-pre-wrap">{message.text}</p>
      <p className={metaClass}>
        {message.textChars.toLocaleString()} chars{!message.complete ? " · provisional" : ""}{!message.current ? " · superseded" : ""}
        {message.audienceHint && message.audienceHint !== "unknown" ? ` · routed to ${message.audienceHint}` : ""}
      </p>
    </NodeCard>
  );
}

type FullMessage = AttentionMessage & { evidence?: unknown };

/** Inspector body for a message: complete immutable text with each item's evidence highlighted, its items, runs and feedback. */
export function AttentionMessageDetail({ id }: { id: string }) {
  const store = useStore();
  const { select } = useWorkbench();
  const [hovered, setHovered] = useState<string | null>(null);
  const message = useSignalRead<FullMessage>(`message:${id}`, () =>
    readChunks((args) => store.call<AttentionChunk>("signal", "attention_message_read", args), { id }).then((text) => JSON.parse(text) as FullMessage));
  const items = useSignalRead(`items:${id}`, () => store.readSignal<AttentionPage<AttentionItem>>("attention_list", { messageId: id, limit: pageSize }));
  const runs = useSignalRead(`runs:${id}`, () => store.readSignal<AttentionPage<AttentionRun>>("attention_run_list", { messageId: id, order: "desc", limit: pageSize }));
  const feedback = useSignalRead(`feedback:${id}`, () => store.call<AttentionPage<AttentionFeedback>>("signal", "attention_feedback_list", { messageId: id, order: "desc", limit: pageSize }));
  const [adding, setAdding] = useState(false);
  const spans = (items.data?.entries ?? []).map((item) => ({ id: item.id, start: item.start, end: item.end }));
  const segments = message.data ? evidenceSegments(message.data.text, spans) : [];
  return (
    <div className="flex flex-col gap-4">
      {message.data ? (
        <>
          <p className={metaClass}>
            {authorLabel(message.data)} · {message.data.conversation}{!message.data.complete ? " · provisional" : ""}{!message.data.current ? " · superseded revision" : ""}
          </p>
          <OpenChatButton conversation={message.data.conversation} />
          <div className="max-h-96 overflow-y-auto rounded-lg border bg-muted/30 p-2.5 text-[0.8rem] text-pretty whitespace-pre-wrap">
            {segments.map((segment) => segment.items.length ? (
              <mark key={segment.start} className={cn("cursor-pointer rounded-sm bg-warning/25 text-inherit", segment.items.includes(hovered ?? "") && "bg-warning/50")}
                onPointerEnter={() => setHovered(segment.items[0]!)} onPointerLeave={() => setHovered(null)} onClick={() => select({ kind: "attention-item", id: segment.items[0]! })}>
                {segment.text}
              </mark>
            ) : <span key={segment.start}>{segment.text}</span>)}
          </div>
        </>
      ) : <p className="text-[0.72rem] text-muted-foreground">{message.error ?? "Reading message…"}</p>}
      {items.data?.entries.length ? (
        <Section title="Items">
          <ul className="flex flex-col gap-1">
            {items.data.entries.map((item) => (
              <li key={item.id} onPointerEnter={() => setHovered(item.id)} onPointerLeave={() => setHovered(null)}
                className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.75rem]", hovered === item.id && "bg-muted")}>
                <Chip className={reasonTone[item.attention.reason]}>{item.attention.reason}</Chip>
                <button type="button" className="min-w-0 flex-1 truncate text-left underline-offset-4 hover:underline" onClick={() => select({ kind: "attention-item", id: item.id })}>{item.summary}</button>
                <span className="shrink-0 text-[0.65rem] text-muted-foreground">{item.state}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {runs.data?.entries.length ? (
        <Section title="Runs">
          <ul className="flex flex-col gap-1">
            {runs.data.entries.map((run) => {
              const view = runView(run.state);
              return (
                <li key={run.id}>
                  <button type="button" onClick={() => select({ kind: "attention-run", id: run.id })}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[0.72rem] hover:bg-muted">
                    <span className={cn("flex items-center gap-1", view.className)}>{view.icon}{view.label}</span>
                    {run.replay ? <span className="text-muted-foreground">· replay</span> : null}
                    <span className="ml-auto font-mono text-[0.65rem] text-muted-foreground">{run.settings.model} · {run.settings.reasoningEffort} · <Time at={run.at} /></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      <Section title="Feedback" aside={<Button type="button" size="xs" variant="ghost" onClick={() => setAdding(true)}><MessageSquarePlusIcon data-icon="inline-start" />Add</Button>}>
        <FeedbackList entries={feedback.data?.entries ?? null} />
      </Section>
      <FeedbackDialog open={adding} onOpenChange={setAdding} messageId={id} runId={null} subject="this message" />
    </div>
  );
}

function FeedbackList({ entries }: { entries: AttentionFeedback[] | null }) {
  if (entries === null) return <p className="text-[0.72rem] text-muted-foreground">Reading…</p>;
  if (!entries.length) return <p className="text-[0.72rem] text-muted-foreground">None recorded.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-0.5 rounded-lg border px-2 py-1.5">
          <span className={metaClass}>{entry.kind} · {entry.author} · <Time at={entry.at} />{entry.runId ? ` · run ${shortId(entry.runId)}` : ""}</span>
          <p className="text-[0.75rem] text-pretty whitespace-pre-wrap">{entry.body}</p>
        </li>
      ))}
    </ul>
  );
}

// ——— Runs: interpretation ledger and traces ———————————————————————————————————————————

/** Every interpretation attempt, newest first, including invalid output, unknown outcomes and replays. */
export function AttentionRunsWindow() {
  const { status, endpoints, signalStatus, accounts } = useStack();
  const [expanded, setExpanded] = useState<string | null>(null);
  const feed = useSignalFeed<AttentionRun>("attention_run_list", {});
  const replayed = new Set((feed.entries ?? []).flatMap((run) => run.replayOf ? [run.replayOf] : []));
  const labels = accountLabels(accounts.data);
  return (
    <Window id="attention-runs" title="Runs" icon={HistoryIcon} accent="events" status={status.signal} endpoint={endpoints.signal}
      updatedAt={signalStatus.at} error={feed.error} count={signalStatus.data?.runs || null}>
      {feed.entries === null ? <p className="text-[0.72rem] text-muted-foreground">{feed.error ?? "Reading…"}</p>
        : feed.entries.length ? (
          <ul className="flex flex-col gap-1.5">
            {feed.entries.map((run) => {
              const view = runView(run.state);
              const open = expanded === run.id;
              const node = { kind: "attention-run", id: run.id } as const;
              const elapsed = duration(run);
              return (
                <li key={run.id}>
                  <NodeCard node={node} label={`${view.label} run`} className="p-0">
                    <div className="flex flex-col gap-1 px-2.5 pt-2">
                      <div className="flex items-center gap-1.5 text-[0.68rem]">
                        <NodeTitle node={node} label={`${view.label} run`} className={cn("flex items-center gap-1 font-medium", view.className)}>{view.icon}{view.label}</NodeTitle>
                        {run.replay ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground"><RotateCcwIcon className="size-3" />replay{run.replayOf ? <> of <NodeLink node={{ kind: "attention-run", id: run.replayOf }} label="original run">{shortId(run.replayOf)}</NodeLink></> : null}</span>
                        ) : null}
                        {run.state === "unknown" && !replayed.has(run.id) ? <Chip className="ml-auto bg-warning/15 text-warning" title="The request may have run and been charged. Nothing retries it automatically.">Needs decision: replay?</Chip> : null}
                        {run.state === "unknown" && replayed.has(run.id) ? <span className="ml-auto text-[0.65rem] text-muted-foreground">replayed</span> : null}
                      </div>
                      {run.error ? <p className="text-[0.72rem] text-pretty text-destructive">{signalErrorText(run.error)}</p> : null}
                    </div>
                    <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? null : run.id)}
                      className="flex items-center gap-1 rounded-b-xl px-2.5 pt-0.5 pb-2 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring">
                      <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                      <span className={metaClass}>
                        {run.settings.model} · {run.settings.reasoningEffort}{elapsed ? ` · ${elapsed}` : ""}
                        {run.settings.accountId ? ` · ${labels.get(run.settings.accountId) ?? shortId(run.settings.accountId)}` : " · first available"} · <Time at={run.at} />
                      </span>
                    </button>
                    {open ? <div className="border-t px-2.5 py-2"><TraceViewer id={run.id} state={run.state} /></div> : null}
                  </NodeCard>
                </li>
              );
            })}
          </ul>
        ) : <Empty icon={HistoryIcon} title="No runs yet" />}
      <MoreButton feed={feed} />
    </Window>
  );
}

type RunExport = {
  run: { id: string; state: string; at: number; finished: number | null; body: Record<string, unknown> & {
    inputBlob?: string; instructionsBlob?: string; responseBlob?: string; promptVersion?: string; requestId?: string; replayOf?: string | null;
    annotation?: { summary: string; items: Array<ItemPair["original"] & object>; stateChanges: Array<{ targetId: string; state: string; quote: string; rationale: string }>; uncertainties: string[] };
    usage?: unknown; reportedModel?: string | null; error?: string; accountCandidates?: string[]; queueMs?: number; itemIds?: string[]; applied?: boolean } };
  message: FullMessage;
  blobs: Record<string, string>;
  events: Array<{ seq: number; at: number; kind: string; body: unknown }>;
  feedback: Array<{ id: string; kind: string; author: string; body: string; runId?: string }>;
};

type TraceTab = "target" | "context" | "instructions" | "completion" | "annotation" | "compare" | "provider" | "events" | "feedback";

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function Pre({ children, className }: { children: React.ReactNode; className?: string }) {
  return <pre className={cn("max-h-80 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-[0.68rem] leading-relaxed whitespace-pre-wrap break-words", className)}>{children}</pre>;
}

/** A run's exact evaluation example, read as a revision-fenced export. Also the inspector body for a run. */
export function TraceViewer({ id, state }: { id: string; state?: string }) {
  const store = useStore();
  const { signalStatus, remote } = useStack();
  const [tab, setTab] = useState<TraceTab>("annotation");
  const [replay, setReplay] = useState<{ requestId: string; pending: boolean; error: string | null } | null>(null);
  const [feedback, setFeedback] = useState(false);
  const trace = useSignalRead<RunExport>(`trace:${id}:${state ?? ""}`, () =>
    readChunks((args) => store.call<AttentionChunk>("signal", "attention_trace_read", args), { id }).then((text) => JSON.parse(text) as RunExport));
  const data = trace.data;
  const body = data?.run.body;
  const input = parseJson(body?.inputBlob ? data?.blobs[body.inputBlob] : undefined) as { target?: Record<string, unknown> & { text?: string }; context?: { messages?: Array<{ id: string; role: string; authorKind: string; text: string; truncated: boolean }>; items?: Array<{ id: string; summary: string; state: string }>; coverage?: string; omittedCandidateItems?: number } } | undefined;
  const response = parseJson(body?.responseBlob ? data?.blobs[body.responseBlob] : undefined) as { text?: string; model?: string; reportedModel?: string | null; usage?: unknown } | undefined;
  const original = useSignalRead<RunExport>(body?.replayOf ? `trace:${body.replayOf}` : null, () =>
    readChunks((args) => store.call<AttentionChunk>("signal", "attention_trace_read", args), { id: body!.replayOf }).then((text) => JSON.parse(text) as RunExport));
  const provider = useSignalRead<InferRequest>(tab === "provider" && body?.requestId ? `infer:${body.requestId}` : null, () => store.call<InferRequest>("infer", "infer_request_get", { requestId: body!.requestId }));
  if (!data) return <p className="text-[0.72rem] text-muted-foreground">{trace.error ?? "Reading trace…"}</p>;
  const tabs: Array<[TraceTab, string]> = [["annotation", "Interpretation"], ...(body?.replayOf ? [["compare", "Compare"] as [TraceTab, string]] : []), ["target", "Target"], ["context", "Context"],
    ["instructions", "Prompt"], ["completion", "Completion"], ["provider", "Provider"], ["events", "Events"], ["feedback", `Feedback${data.feedback.length ? ` ${data.feedback.length}` : ""}`]];
  const completionText = response?.text;
  const pretty = completionText !== undefined ? parseJson(completionText) : undefined;
  const settings = signalStatus.data?.settings;
  const startReplay = async (requestId: string) => {
    setReplay({ requestId, pending: true, error: null });
    try {
      await store.signalAction("attention_replay", { runId: id, requestId });
      setReplay(null);
      toast.success(signalStatus.data?.enabled ? "Replay queued" : "Replay queued; it runs when processing resumes");
    } catch (cause) {
      setReplay({ requestId, pending: false, error: signalErrorText(errorMessage(cause)) });
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup value={[tab]} onValueChange={(value: string[]) => { if (value.length) setTab(value[0] as TraceTab); }} spacing={0} size="sm" variant="outline" aria-label="Trace section" className="flex-wrap">
        {tabs.map(([value, label]) => <ToggleGroupItem key={value} value={value} className="text-[0.68rem]">{label}</ToggleGroupItem>)}
      </ToggleGroup>
      {tab === "annotation" ? (
        body?.annotation ? (
          <div className="flex flex-col gap-2">
            <p className="text-[0.78rem] text-pretty">{body.annotation.summary || <span className="text-muted-foreground italic">No summary</span>}</p>
            <ul className="flex flex-col gap-1">
              {body.annotation.items.map((item, index) => (
                <li key={index} className="flex flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-[0.75rem]">
                  <span className="flex items-center gap-1"><Chip className={reasonTone[item.attention.reason]}>{item.attention.reason}</Chip><span className="text-[0.65rem] text-muted-foreground">{item.state} · for {item.audience.kind}</span></span>
                  <span className="text-pretty">{item.summary}</span>
                  <span className="line-clamp-2 text-[0.7rem] text-muted-foreground">“{item.evidence.quote}”</span>
                </li>
              ))}
            </ul>
            {body.annotation.stateChanges.length ? (
              <ul className="flex flex-col gap-0.5 text-[0.72rem]">
                {body.annotation.stateChanges.map((change, index) => <li key={index}>Marks <span className="font-mono text-[0.65rem]">{shortId(change.targetId, 12)}</span> {change.state}: “{change.quote}”</li>)}
              </ul>
            ) : null}
            {body.annotation.uncertainties.map((text, index) => <p key={index} className="text-[0.72rem] text-warning">? {text}</p>)}
            <p className={metaClass}>{body.applied ? "Applied to live attention" : body.replayOf ? "Evaluation only; live attention unchanged" : "Not applied (superseded source)"}</p>
          </div>
        ) : <p className="text-[0.72rem] text-muted-foreground">{body?.error ? `No interpretation: ${signalErrorText(String(body.error))}` : "No interpretation recorded."}</p>
      ) : null}
      {tab === "compare" ? (
        original.data?.run.body.annotation && body?.annotation ? <Compare pairs={pairInterpretations(original.data.run.body.annotation.items, body.annotation.items)} /> : <p className="text-[0.72rem] text-muted-foreground">{original.error ?? (original.data ? "One side has no interpretation." : "Reading the original…")}</p>
      ) : null}
      {tab === "target" ? (
        <div className="flex flex-col gap-1.5">
          <p className={metaClass}>{String(input?.target?.role ?? "")} · {String(input?.target?.authorKind ?? "")} · default audience {String(input?.target?.defaultAudience ?? "unknown")}</p>
          <Pre>{input?.target?.text ?? "Target unavailable"}</Pre>
        </div>
      ) : null}
      {tab === "context" ? (
        <div className="flex flex-col gap-1.5">
          <p className={metaClass}>{input?.context?.coverage ?? "context"}{input?.context?.omittedCandidateItems ? ` · ${input.context.omittedCandidateItems} candidate items omitted` : ""}</p>
          {(input?.context?.messages ?? []).map((message) => (
            <div key={message.id} className="flex flex-col gap-0.5">
              <span className={metaClass}>{message.role} · {message.authorKind}{message.truncated ? " · last 3,000 chars" : ""}</span>
              <Pre className="max-h-32">{message.text}</Pre>
            </div>
          ))}
          {input?.context?.items?.length ? (
            <ul className="flex flex-col gap-0.5 text-[0.72rem]">
              {input.context.items.map((item) => <li key={item.id}><span className="text-muted-foreground">{item.state}</span> {item.summary}</li>)}
            </ul>
          ) : null}
          {!input?.context?.messages?.length && !input?.context?.items?.length ? <p className="text-[0.72rem] text-muted-foreground">No prior context.</p> : null}
        </div>
      ) : null}
      {tab === "instructions" ? <><p className={metaClass}>{body?.promptVersion ?? "unversioned"}</p><Pre>{body?.instructionsBlob ? data.blobs[body.instructionsBlob] : "Unavailable"}</Pre></> : null}
      {tab === "completion" ? (
        response ? (
          <div className="flex flex-col gap-1.5">
            <p className={metaClass}>{response.model}{response.reportedModel && response.reportedModel !== response.model ? ` (reported ${response.reportedModel})` : ""}</p>
            <Pre>{pretty !== undefined ? JSON.stringify(pretty, null, 2) : completionText || "Empty completion"}</Pre>
            {pretty === undefined ? <p className="text-[0.68rem] text-destructive">Not valid JSON; kept as evidence.</p> : null}
          </div>
        ) : <p className="text-[0.72rem] text-muted-foreground">No completion recorded{body?.error ? `: ${signalErrorText(String(body.error))}` : "."}</p>
      ) : null}
      {tab === "provider" ? (
        provider.data ? (
          <dl className="flex flex-col">
            <Row label="State">{provider.data.state}</Row>
            <Row label="Model" mono>{provider.data.reportedModel ?? provider.data.model}</Row>
            <Row label="Tokens in / out">{provider.data.usage ? `${provider.data.usage.inputTokens ?? "?"} / ${provider.data.usage.outputTokens ?? "?"}` : "unreported"}</Row>
            {provider.data.error ? <Row label="Error">{provider.data.error}</Row> : null}
          </dl>
        ) : <p className="text-[0.72rem] text-muted-foreground">{!body?.requestId ? "No inference request." : provider.error ?? "Reading infer's ledger…"}</p>
      ) : null}
      {tab === "events" ? (
        <ul className="flex flex-col gap-1">
          {data.events.map((event) => (
            <li key={event.seq} className="flex flex-col gap-0.5">
              <span className={metaClass}>{event.kind} · <Time at={event.at} /></span>
              <Pre className="max-h-24">{JSON.stringify(event.body)}</Pre>
            </li>
          ))}
        </ul>
      ) : null}
      {tab === "feedback" ? <FeedbackList entries={data.feedback.map((entry, index) => ({ cursor: index, at: 0, messageId: data.message.id, runId: entry.runId ?? null, ...entry, kind: entry.kind as AttentionFeedbackKind }))} /> : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.62rem] text-muted-foreground" title={body?.requestId}>request {body?.requestId ?? "—"}</span>
        {body?.requestId ? <CopyButton value={body.requestId} label="request ID" className="opacity-100" /> : null}
        <Button type="button" size="xs" variant="ghost" disabled={remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => setFeedback(true)}><MessageSquarePlusIcon data-icon="inline-start" />Feedback</Button>
        <Button type="button" size="xs" variant="outline" disabled={data.run.state === "running" || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => setReplay({ requestId: crypto.randomUUID(), pending: false, error: null })}>
          <RotateCcwIcon data-icon="inline-start" />Replay…
        </Button>
      </div>
      <FeedbackDialog open={feedback} onOpenChange={setFeedback} messageId={data.message.id} runId={id} subject="this run" />
      <AlertDialog open={replay !== null} onOpenChange={(open) => { if (!open && !replay?.pending) setReplay(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Replay this interpretation?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              Re-interprets the run’s frozen input with the current defaults{settings ? ` (${settings.model} · ${settings.reasoningEffort})` : ""} and prompt, as a new run. It never changes live attention.
              {signalStatus.data?.enabled ? " It spends Codex allowance." : " Processing is paused, so it waits and spends allowance once processing resumes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {replay?.error ? <p role="alert" className="text-[0.72rem] text-destructive">{replay.error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={replay?.pending}>Cancel</AlertDialogCancel>
            {/* A retry reuses the request ID, so a lost acknowledgement never queues twice. */}
            <Button disabled={replay?.pending} onClick={() => replay && void startReplay(replay.requestId)}>{replay?.pending ? <Spinner data-icon="inline-start" /> : null}{replay?.error ? "Retry" : "Replay"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Compare({ pairs }: { pairs: ItemPair[] }) {
  if (!pairs.length) return <p className="text-[0.72rem] text-muted-foreground">Neither run found items.</p>;
  const side = (item: ItemPair["original"]) => item ? (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1"><Chip className={reasonTone[item.attention.reason]}>{item.attention.reason}</Chip><span className="text-[0.62rem] text-muted-foreground">{item.state}</span></span>
      <span className="text-pretty">{item.summary}</span>
    </div>
  ) : <span className="text-muted-foreground italic">not found</span>;
  return (
    <div className="flex flex-col gap-1.5 text-[0.72rem]">
      <div className="grid grid-cols-2 gap-2 px-1 text-[0.62rem] font-medium tracking-[0.08em] text-muted-foreground uppercase"><span>Original</span><span>Replay</span></div>
      {pairs.map((pair, index) => {
        const same = pair.original && pair.replay && pair.original.attention.reason === pair.replay.attention.reason && pair.original.state === pair.replay.state && pair.original.audience.kind === pair.replay.audience.kind;
        return (
          <div key={index} className={cn("flex flex-col gap-1 rounded-lg border px-2 py-1.5", !same && "border-warning/40 bg-warning/5")}>
            <span className="line-clamp-1 text-[0.65rem] text-muted-foreground">“{pair.quote}”</span>
            <div className="grid grid-cols-2 gap-2">{side(pair.original)}{side(pair.replay)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ——— Changes: durable event log ————————————————————————————————————————————————————

const eventKinds = ["message_observed", "message_restored", "source_messages_retired", "source_reset", "source_coverage", "baseline_established",
  "run_started", "run_finished", "inference_selected", "inference_attempt_failed", "item_state_changed", "feedback_recorded",
  "processing_control", "settings_changed", "collection_error", "processing_error", ...readEventKinds];

/** The durable change sequence. Source-read polling is hidden unless asked for. */
export function AttentionChangesWindow() {
  const store = useStore();
  const { select } = useWorkbench();
  const { status, endpoints, signalStatus } = useStack();
  const [kind, setKind] = useState("attention");
  const [full, setFull] = useState<Record<number, string>>({});
  const filters = kind === "attention" ? { excludeKinds: readEventKinds } : kind === "all" ? {} : { kinds: [kind] };
  const feed = useSignalFeed<AttentionEvent>("attention_changes", filters);
  const expand = (seq: number) => {
    readChunks((args) => store.call<AttentionChunk>("signal", "attention_event_read", args), { seq }).then(
      (text) => setFull((all) => ({ ...all, [seq]: JSON.stringify((JSON.parse(text) as { body: unknown }).body, null, 2) })),
      (cause) => toast.error(signalErrorText(errorMessage(cause))));
  };
  const link = (event: AttentionEvent) => {
    const body = event.body ?? {};
    if (event.kind === "item_state_changed" && typeof body.targetId === "string") return <button type="button" className="underline-offset-4 hover:underline" onClick={() => select({ kind: "attention-item", id: body.targetId as string })}>{String(body.previousState)} → {String(body.state)}</button>;
    const run = event.kind === "run_started" || event.kind === "run_finished" ? body.id : body.runId;
    if (typeof run === "string") return <button type="button" className="underline-offset-4 hover:underline" onClick={() => select({ kind: "attention-run", id: run })}>run {shortId(run)}{event.kind === "run_finished" ? ` ${String(body.state)}` : ""}</button>;
    if (event.kind === "message_observed" && typeof body.id === "string") return <button type="button" className="underline-offset-4 hover:underline" onClick={() => select({ kind: "attention-message", id: body.id as string })}>message in {String(body.conversation)}</button>;
    return null;
  };
  return (
    <Window id="attention-changes" title="Changes" icon={ActivityIcon} accent="events" status={status.signal} endpoint={endpoints.signal} updatedAt={signalStatus.at} error={feed.error}>
      <NativeSelect size="sm" aria-label="Event kind" value={kind} onChange={(event) => setKind(event.target.value)}>
        <NativeSelectOption value="attention">Attention changes</NativeSelectOption>
        <NativeSelectOption value="all">Everything, with source reads</NativeSelectOption>
        {eventKinds.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
      </NativeSelect>
      {feed.entries === null ? <p className="text-[0.72rem] text-muted-foreground">{feed.error ?? "Reading…"}</p>
        : feed.entries.length ? (
          <ul className="flex flex-col gap-1">
            {feed.entries.map((event) => (
              <li key={event.seq} className="group/row flex flex-col gap-0.5 rounded-md px-1.5 py-1 hover:bg-muted/50">
                <span className="flex items-center gap-1.5 text-[0.7rem]">
                  <span className="font-mono">{event.kind}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{link(event)}</span>
                  <Time at={event.at} className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground" />
                </span>
                {full[event.seq] ? <Pre className="max-h-48">{full[event.seq]}</Pre>
                  : event.omitted ? <button type="button" className="self-start text-[0.65rem] text-muted-foreground underline-offset-4 hover:underline" onClick={() => expand(event.seq)}>Read full body ({event.bodyChars.toLocaleString()} chars)</button>
                  : event.body ? <p className="line-clamp-1 font-mono text-[0.62rem] break-all text-muted-foreground" title={JSON.stringify(event.body)}>{JSON.stringify(event.body)}</p> : null}
              </li>
            ))}
          </ul>
        ) : <Empty icon={ActivityIcon} title="No changes" />}
      <MoreButton feed={feed} />
    </Window>
  );
}

/** Inspector body for a semantic item: its handoffs to the conversation, source, trace and feedback. */
export function AttentionItemDetail({ item }: { item: AttentionItem }) {
  const { select } = useWorkbench();
  const { remote } = useStack();
  const [feedback, setFeedback] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <blockquote className="border-l-2 pl-2 text-[0.8rem] text-pretty text-muted-foreground">“{item.evidence.quote}”</blockquote>
      <p className="text-[0.75rem] text-pretty"><span className="text-muted-foreground">Why:</span> {item.attention.rationale || "no rationale"} ({item.attention.basis})</p>
      <div className="flex flex-wrap gap-1.5">
        <OpenChatButton conversation={item.conversation} />
        <Button type="button" size="xs" variant="outline" onClick={() => select({ kind: "attention-message", id: item.messageId })}><FileSearchIcon data-icon="inline-start" />Source</Button>
        <Button type="button" size="xs" variant="outline" onClick={() => select({ kind: "attention-run", id: item.runId })}><HistoryIcon data-icon="inline-start" />Trace</Button>
        <Button type="button" size="xs" variant="outline" disabled={remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => setFeedback(true)}><MessageSquarePlusIcon data-icon="inline-start" />Feedback</Button>
      </div>
      <p className="text-[0.68rem] text-pretty text-muted-foreground">State follows the conversation: a reply that answers this resolves it. Feedback never does.</p>
      <FeedbackDialog open={feedback} onOpenChange={setFeedback} messageId={item.messageId} runId={item.runId} subject={`“${item.summary}”`} />
    </div>
  );
}
