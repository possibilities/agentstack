"use client";

import { useId, useMemo, useState } from "react";
import { BlocksIcon, CircleCheckIcon, CircleXIcon, ClipboardCheckIcon, FolderInputIcon, GaugeIcon, ListChecksIcon, PlayIcon, RefreshCwIcon, SendIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { untilTime } from "@/lib/stack/derive";
import { canaryView, jobLabel, parseFrontmatter, scrapeCallError, scrapeCapabilities, scrapeLocalReason, type CallError } from "@/lib/stack/scrape";
import type { ScrapePreset, ScrapeQueueJob, ScrapeQueueResult } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty, Flash, NodeCard, NodeTitle, Row, StatusDot, Time, type Tone } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { CallErrorNote, EgressConsent, Elapsed, fieldLabel } from "./scrape-shared";
import { footerButton, Section, Window } from "./window";

const badge = "rounded-md bg-muted px-1.5 py-px font-mono text-[0.64rem] text-muted-foreground";

function unavailable(endpoints: Record<string, string>, status: Record<string, string>): string | null {
  return !endpoints.scrape ? "Scrape isn't served by this server" : status.scrape !== "open" ? "Scrape reconnecting" : null;
}

/**
 * Official and AgentStack-local presets, grouped by the host each claims. A claimed host fails
 * closed for URLs no pattern matches; `*` presets run only when chosen explicitly.
 */
export function PresetsWindow() {
  const store = useStore();
  const { status, endpoints, scrapePresets, scrapeCanaries } = useStack();
  const presets = scrapePresets.data ?? [];
  const canaries = new Set(scrapeCanaries.data ?? []);
  const groups = useMemo(() => {
    const byDomain = new Map<string, ScrapePreset[]>();
    for (const preset of presets) byDomain.set(preset.domain, [...(byDomain.get(preset.domain) ?? []), preset]);
    return [...byDomain].sort(([left], [right]) => (left === "*" ? 1 : right === "*" ? -1 : left.localeCompare(right)));
  }, [presets]);
  return (
    <Window id="scrape-presets" title="Presets" icon={BlocksIcon} accent="scrape" count={scrapePresets.data ? presets.length : null}
      status={endpoints.scrape ? status.scrape : undefined} endpoint={endpoints.scrape} updatedAt={scrapePresets.at} error={scrapePresets.error ?? scrapeCanaries.error}
      empty={!presets.length}
      actions={endpoints.scrape ? (
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Read presets again" title="Read presets again" disabled={status.scrape !== "open"} onClick={store.refreshScrape}>
          <RefreshCwIcon />
        </Button>
      ) : null}>
      {!presets.length ? <Empty icon={BlocksIcon} title={!endpoints.scrape ? "Scrape isn't served by this server" : scrapePresets.data ? "No presets" : "Reading presets…"} /> : groups.map(([domain, list]) => (
        <Section key={domain} title={domain === "*" ? "Explicit link presets" : domain}
          aside={domain === "*" ? <span className="text-[0.65rem] text-muted-foreground">Any host, chosen by name</span>
            : list[0].aliases.length ? <span className="font-mono text-[0.65rem] text-muted-foreground">also {list[0].aliases.join(", ")}</span> : null}>
          <ul className="flex flex-col gap-0.5">
            {list.map((preset) => (
              <li key={preset.name} data-node={`preset:${preset.name}`} className="relative">
                <Flash id={`preset:${preset.name}`} />
                <NodeCard node={{ kind: "preset", id: preset.name }} label={preset.name} variant="row">
                  <div className="flex items-center gap-2">
                    <NodeTitle node={{ kind: "preset", id: preset.name }} label={preset.name} className="truncate font-mono text-[0.76rem] font-medium">{preset.name}</NodeTitle>
                    <span className={badge}>{preset.mode}</span>
                    {preset.source === "local" ? <span className={cn(badge, "bg-pkg-scrape/15 text-pkg-scrape")}>local</span> : null}
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-[0.64rem] text-muted-foreground" title={canaries.has(preset.name) ? "A live canary is configured; that is not a passing check" : "No live canary configured"}>
                      <StatusDot tone={canaries.has(preset.name) ? "info" : "muted"} />{canaries.has(preset.name) ? "canary" : "no canary"}
                    </span>
                    <Button type="button" size="xs" variant="ghost" onClick={() => store.composeScrape(preset.name, preset.mode === "content" ? "page" : "links")} title="Choose this preset in Extract">Use</Button>
                  </div>
                  {preset.summary ? <p className="line-clamp-2 text-[0.7rem] text-pretty text-muted-foreground">{preset.summary}</p> : null}
                </NodeCard>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </Window>
  );
}

/**
 * Offline corpus replay and live canary checks. Replay proves recorded shapes only; a canary pass
 * proves only its configured sample, and `not_configured` is never a pass. Results are this page's.
 */
export function ChecksWindow() {
  const store = useStore();
  const { status, endpoints, scrapePresets, scrapeCanaries, scrapeChecks, remote } = useStack();
  const formId = useId();
  const presets = scrapePresets.data ?? [];
  const configured = scrapeCanaries.data ?? [];
  const [replayPreset, setReplayPreset] = useState("");
  const [canaryPresets, setCanaryPresets] = useState<string[] | null>(null);
  const [session, setSession] = useState("");
  const [consent, setConsent] = useState(false);
  const offline = unavailable(endpoints, status);
  const { replay, canary } = scrapeChecks;
  const replaying = Boolean(replay && replay.finishedAt === null);
  const checking = Boolean(canary && canary.finishedAt === null);
  const selected = canaryPresets ?? configured;
  const canaryBlocked = scrapeLocalReason(remote) ?? offline ?? (!selected.length ? "Choose at least one preset" : !consent ? "Allow browser egress to run canaries" : null);

  const runReplay = () => {
    if (offline || replaying) return;
    void store.scrapeCheck("replay", replayPreset ? { preset: replayPreset } : {});
  };
  const runCanaries = () => {
    if (canaryBlocked || checking) return;
    setConsent(false);
    void store.scrapeCheck("canary", { presets: selected, session: session.trim() || undefined, allowPrivateNetwork: true });
  };
  const toggle = (name: string, on: boolean) => setCanaryPresets((current) => {
    const base = current ?? configured;
    return on ? [...new Set([...base, name])] : base.filter((item) => item !== name);
  });

  return (
    <Window id="scrape-checks" title="Checks" icon={ListChecksIcon} accent="scrape" status={endpoints.scrape ? status.scrape : undefined} endpoint={endpoints.scrape} empty={!endpoints.scrape}>
      {!endpoints.scrape ? <Empty icon={ListChecksIcon} title="Scrape isn't served by this server" /> : (
        <>
          <Section title="Corpus replay" aside={<span className="text-[0.65rem] text-muted-foreground">Offline · recorded shapes</span>}>
            <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); runReplay(); }}>
              <label htmlFor={`${formId}-replay`} className="sr-only">Preset to replay</label>
              <NativeSelect id={`${formId}-replay`} size="sm" className="min-w-0 flex-1" value={replayPreset} disabled={replaying} onChange={(event) => setReplayPreset(event.target.value)}>
                <NativeSelectOption value="">Every preset</NativeSelectOption>
                {presets.map((preset) => <NativeSelectOption key={preset.name} value={preset.name}>{preset.name}</NativeSelectOption>)}
              </NativeSelect>
              <Button type="submit" size="sm" disabled={Boolean(offline) || replaying} title={offline ?? undefined}>
                {replaying ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}Replay
              </Button>
            </form>
            {replay ? (
              replay.finishedAt === null ? <p className="px-0.5 text-[0.7rem] text-muted-foreground">Replaying · <Elapsed since={replay.startedAt} /></p>
              : replay.error ? <CallErrorNote error={{ text: replay.error, uncertain: replay.uncertain }} />
              : replay.result ? (
                <div className="flex flex-col gap-1.5">
                  <p className="flex items-center gap-2 px-0.5 text-[0.74rem]">
                    {replay.result.failed ? <CircleXIcon className="size-3.5 text-destructive" /> : <CircleCheckIcon className="size-3.5 text-success" />}
                    <span className="font-medium">{replay.result.passed} passed · {replay.result.failed} failed</span>
                    <span className="ml-auto text-[0.66rem] text-muted-foreground"><Time at={replay.finishedAt} /></span>
                  </p>
                  <ul className="flex max-h-56 flex-col overflow-auto rounded-lg bg-muted/50 p-1.5 font-mono text-[0.66rem]">
                    {replay.result.lines.map((line, index) => (
                      <li key={index} className={cn("px-1 py-px break-all", /^\s*FAIL/.test(line) ? "text-destructive" : "text-muted-foreground")}>{line.trim()}</li>
                    ))}
                  </ul>
                </div>
              ) : null
            ) : null}
          </Section>
          <Section title="Live canaries" aside={<span className="text-[0.65rem] text-muted-foreground">Navigates configured samples</span>}>
            <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); runCanaries(); }}>
              <fieldset disabled={checking} className="flex flex-col gap-1 rounded-lg border p-2">
                <legend className={fieldLabel}>Presets</legend>
                {presets.map((preset) => (
                  <label key={preset.name} htmlFor={`${formId}-canary-${preset.name}`} className="flex items-center gap-2 text-[0.74rem]">
                    <Switch id={`${formId}-canary-${preset.name}`} size="sm" checked={selected.includes(preset.name)} onCheckedChange={(on) => toggle(preset.name, on)} />
                    <span className="font-mono">{preset.name}</span>
                    {configured.includes(preset.name) ? null : <span className="ml-auto text-[0.64rem] text-muted-foreground">not configured</span>}
                  </label>
                ))}
              </fieldset>
              <label className="flex flex-col gap-1">
                <span className={fieldLabel}>Browser session (optional)</span>
                <Input value={session} disabled={checking} placeholder="signed-in session name" spellCheck={false} autoComplete="off"
                  onChange={(event) => setSession(event.target.value)} className="h-7 font-mono text-[0.74rem]" />
              </label>
              <EgressConsent checked={consent} onChange={setConsent} disabled={checking || Boolean(scrapeLocalReason(remote))} />
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[0.68rem] text-pretty text-muted-foreground">
                  {checking && canary ? <>Checking · <Elapsed since={canary.startedAt} /></> : canaryBlocked ?? "Reuses the session without closing it"}
                </span>
                <Button type="submit" size="sm" disabled={Boolean(canaryBlocked) || checking} title={canaryBlocked ?? undefined}>
                  {checking ? <Spinner data-icon="inline-start" /> : <ClipboardCheckIcon data-icon="inline-start" />}Check
                </Button>
              </div>
            </form>
            {canary && canary.finishedAt !== null ? (
              canary.error ? <CallErrorNote error={{ text: canary.error, uncertain: canary.uncertain }} /> : canary.result ? (
                <div className="flex flex-col gap-1">
                  <p className="px-0.5 text-[0.66rem] text-muted-foreground">Checked <Time at={Date.parse(canary.result.checked_at)} /></p>
                  <ul className="flex flex-col gap-0.5">
                    {canary.result.results.map((result) => (
                      <li key={result.preset} className="flex min-w-0 flex-col rounded-md px-1.5 py-1 hover:bg-muted/70">
                        <span className="flex items-center gap-2 text-[0.74rem]">
                          <StatusDot tone={canaryView[result.status].tone} />
                          <span className="font-mono">{result.preset}</span>
                          <span className={cn("ml-auto text-[0.68rem]", result.status === "not_configured" ? "text-muted-foreground" : result.status === "pass" ? "text-success" : result.status === "drift" ? "text-destructive" : "text-warning")}>
                            {canaryView[result.status].label}
                          </span>
                        </span>
                        {result.detail ? <span className="font-mono text-[0.64rem] break-all text-muted-foreground">{result.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            ) : null}
          </Section>
        </>
      )}
    </Window>
  );
}

/** Scrape's isolated state root and which optional route executables this machine has. */
export function StatusWindow() {
  const store = useStore();
  const { status, endpoints, scrapeStatus } = useStack();
  const data = scrapeStatus.data;
  return (
    <Window id="scrape-status" title="Status" icon={GaugeIcon} accent="scrape" status={endpoints.scrape ? status.scrape : undefined} endpoint={endpoints.scrape}
      updatedAt={scrapeStatus.at} error={scrapeStatus.error} empty={!data}
      actions={endpoints.scrape ? (
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Read status again" title="Read status again" disabled={status.scrape !== "open"} onClick={store.refreshScrape}>
          <RefreshCwIcon />
        </Button>
      ) : null}>
      {!data ? <Empty icon={GaugeIcon} title={!endpoints.scrape ? "Scrape isn't served by this server" : "Reading status…"} /> : (
        <>
          <dl className="flex flex-col">
            <Row label="State" mono copy={data.stateRoot}><span title={data.stateRoot}>{data.stateRoot}</span></Row>
          </dl>
          <Section title="Route tools" aside={<span className="text-[0.65rem] text-muted-foreground">Present, not proven working</span>}>
            <ul className="flex flex-col gap-0.5">
              {scrapeCapabilities.map((item) => (
                <li key={item.key} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[0.74rem]">
                  <StatusDot tone={data[item.key] ? "success" : "muted"} label={data[item.key] ? "Found" : "Missing"} />
                  <span className="font-mono">{item.tool}</span>
                  <span className={cn("ml-auto truncate text-right text-[0.68rem]", data[item.key] ? "text-muted-foreground" : "text-foreground")} title={item.routes}>
                    {data[item.key] ? item.routes : `Missing · ${item.routes} unavailable`}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </Window>
  );
}

const stateTone: Record<ScrapeQueueJob["state"], Tone> = { pending: "info", retrying: "warning", failed: "destructive" };
const stateTitle: Record<ScrapeQueueJob["state"], string> = { pending: "Pending", retrying: "Retrying", failed: "Failed" };

/**
 * The scrape-to-file queue. Jobs write operator-chosen files when processed (by the server's Scrape
 * child every minute, or Process now). A lost submit may still have queued the job: the list is
 * re-read and nothing is resent. Failed records keep no reason.
 */
export function QueueWindow() {
  const store = useStore();
  const { status, endpoints, scrapeQueue, remote } = useStack();
  const formId = useId();
  const now = useNow(30_000);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState({ url: "", destination: "", summarize: false, frontmatter: "" });
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<CallError | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [processing, setProcessing] = useState<number | null>(null);
  const [processed, setProcessed] = useState<{ result: ScrapeQueueResult; at: number } | { error: CallError } | null>(null);
  const queue = scrapeQueue.data;
  const blocked = scrapeLocalReason(remote) ?? unavailable(endpoints, status);
  const frontmatter = parseFrontmatter(draft.frontmatter);

  const submit = async () => {
    if (blocked || submitting) return;
    if (!draft.url.trim() || !draft.destination.trim()) { setSubmitError({ text: "Enter a URL and a destination path", uncertain: false }); return; }
    if (!frontmatter) { setSubmitError({ text: "Frontmatter lines must be key: value", uncertain: false }); return; }
    setSubmitting(true);
    setSubmitError(null);
    setSubmitted(null);
    const allow = consent;
    setConsent(false);
    try {
      const result = await store.scrapeQueueAction<{ path: string }>("scrape_queue_submit", { url: draft.url.trim(), destination: draft.destination.trim(),
        summarize: draft.summarize || undefined, frontmatter: Object.keys(frontmatter).length ? frontmatter : undefined, allowPrivateNetwork: allow || undefined });
      setSubmitted(result.path);
      setDraft({ url: "", destination: "", summarize: false, frontmatter: "" });
    } catch (error) {
      const failure = scrapeCallError(error);
      setSubmitError(failure.uncertain ? { ...failure, text: `${failure.text} Check the list before submitting again.` } : failure);
    } finally {
      setSubmitting(false);
    }
  };
  const process = async () => {
    if (blocked || processing) return;
    const started = Date.now();
    setProcessing(started);
    try {
      setProcessed({ result: await store.scrapeQueueAction<ScrapeQueueResult>("scrape_queue_process", {}), at: Date.now() });
    } catch (error) {
      setProcessed({ error: scrapeCallError(error) });
    } finally {
      setProcessing(null);
    }
  };

  return (
    <Window id="scrape-queue" title="Queue" icon={FolderInputIcon} accent="scrape" count={queue ? queue.counts.pending + queue.counts.retrying + queue.counts.failed : null}
      status={endpoints.scrape ? status.scrape : undefined} endpoint={endpoints.scrape} updatedAt={scrapeQueue.at} error={scrapeQueue.error}
      empty={!queue?.jobs.length && !composing && !processed}
      footer={endpoints.scrape ? (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" className={footerButton} aria-expanded={composing} onClick={() => setComposing(!composing)}><SendIcon data-icon="inline-start" />Submit job…</Button>
          <Button variant="ghost" size="sm" className={footerButton} disabled={Boolean(blocked) || Boolean(processing)} title={blocked ?? "Process ready jobs and due retries once"} onClick={() => void process()}>
            {processing ? <Spinner data-icon="inline-start" /> : <WrenchIcon data-icon="inline-start" />}{processing ? <>Processing · <Elapsed since={processing} /></> : "Process now"}
          </Button>
        </div>
      ) : undefined}>
      {queue ? (
        <p className="flex flex-wrap gap-x-3 px-0.5 text-[0.7rem] text-muted-foreground">
          {(["pending", "retrying", "failed"] as const).map((state) => (
            <span key={state} className="flex items-center gap-1"><StatusDot tone={queue.counts[state] ? stateTone[state] : "muted"} />{queue.counts[state]} {state}</span>
          ))}
          <span className="ml-auto">Processed every minute</span>
        </p>
      ) : null}
      {composing ? (
        <form className="flex flex-col gap-2 rounded-lg border p-2.5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>URL</span>
            <Input type="url" value={draft.url} disabled={submitting} placeholder="https://…" spellCheck={false} autoComplete="off"
              onChange={(event) => { setDraft({ ...draft, url: event.target.value }); setSubmitError(null); }} className="h-7 font-mono text-[0.74rem]" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Destination file on the AgentStack machine</span>
            <Input value={draft.destination} disabled={submitting} placeholder="~/notes/page.md" spellCheck={false} autoComplete="off"
              onChange={(event) => { setDraft({ ...draft, destination: event.target.value }); setSubmitError(null); }} className="h-7 font-mono text-[0.74rem]" />
            <span className="px-0.5 text-[0.64rem] text-muted-foreground">Processing overwrites this file. This is not Brain admission.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Frontmatter (key: value per line)</span>
            <Textarea value={draft.frontmatter} disabled={submitting} placeholder="source: reading list" aria-invalid={frontmatter ? undefined : true}
              onChange={(event) => { setDraft({ ...draft, frontmatter: event.target.value }); setSubmitError(null); }} className="max-h-28 min-h-12 font-mono text-[0.72rem]" />
          </label>
          <label htmlFor={`${formId}-summarize`} className="flex items-center gap-2 text-[0.74rem]">
            <Switch id={`${formId}-summarize`} size="sm" checked={draft.summarize} disabled={submitting} onCheckedChange={(checked) => setDraft({ ...draft, summarize: checked })} />
            Add a summary <span className="text-[0.66rem] text-muted-foreground">(needs summaryctl)</span>
          </label>
          <EgressConsent checked={consent} onChange={setConsent} disabled={submitting || Boolean(blocked)} />
          <CallErrorNote error={submitError} />
          {submitted ? <p className="flex items-center gap-1 px-0.5 text-[0.7rem] text-success">Queued <span className="truncate font-mono text-muted-foreground" title={submitted}>{submitted.split("/").at(-1)}</span></p> : null}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[0.68rem] text-muted-foreground">{blocked ?? "The job keeps this egress choice"}</span>
            <Button type="submit" size="sm" disabled={Boolean(blocked) || submitting} title={blocked ?? undefined}>
              {submitting ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}Submit
            </Button>
          </div>
        </form>
      ) : null}
      {processed ? ("error" in processed ? <CallErrorNote error={processed.error} /> : (
        <p className="px-0.5 text-[0.7rem] text-muted-foreground">
          Processed <Time at={processed.at} />: {processed.result.processed} written · {processed.result.failed} failed · {processed.result.retry_scheduled} retry scheduled
          {processed.result.retry_waiting ? ` · ${processed.result.retry_waiting} waiting` : ""}{processed.result.retry_exhausted ? ` · ${processed.result.retry_exhausted} exhausted` : ""}
        </p>
      )) : null}
      {!queue ? <Empty icon={FolderInputIcon} title={!endpoints.scrape ? "Scrape isn't served by this server" : "Reading queue…"} />
        : !queue.jobs.length ? (composing ? null : <Empty icon={FolderInputIcon} title="Queue empty" />) : (
          <ul className="flex flex-col gap-0.5">
            {queue.jobs.map((job) => (
              <li key={job.id} data-node={`scrape-job:${job.id}`} className="relative">
                <Flash id={`scrape-job:${job.id}`} />
                <NodeCard node={{ kind: "scrape-job", id: job.id }} label={jobLabel(job)} variant="row">
                  <div className="flex items-center gap-2">
                    <StatusDot tone={stateTone[job.state]} label={stateTitle[job.state]} />
                    <NodeTitle node={{ kind: "scrape-job", id: job.id }} label={jobLabel(job)} className="min-w-0 truncate font-mono text-[0.74rem]">{jobLabel(job)}</NodeTitle>
                    {job.url ? <CopyButton value={job.url} label="URL" /> : null}
                    <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground">{job.submitted_at ? <Time at={Date.parse(job.submitted_at)} /> : stateTitle[job.state]}</span>
                  </div>
                  <p className="flex min-w-0 gap-2 text-[0.66rem] text-muted-foreground">
                    {job.destination ? <span className="truncate font-mono" title={job.destination}>→ {job.destination}</span> : null}
                    {job.state === "retrying" && job.max_attempts ? (
                      <span className="ml-auto shrink-0">attempt {job.completed_failures + 1}/{job.max_attempts}{job.next_attempt_at ? ` · ${untilTime(Date.parse(job.next_attempt_at), now)}` : ""}</span>
                    ) : null}
                  </p>
                  {job.problem ? <p className="text-[0.66rem] break-all text-destructive">{job.problem}</p>
                    : job.state === "failed" ? <p className="text-[0.66rem] text-muted-foreground">Failed · the queue records no reason; try the URL in Extract</p> : null}
                </NodeCard>
              </li>
            ))}
          </ul>
        )}
      {queue?.truncated ? <p className="px-0.5 text-[0.66rem] text-muted-foreground">Showing the newest {queue.jobs.length} jobs; counts include all.</p> : null}
    </Window>
  );
}
