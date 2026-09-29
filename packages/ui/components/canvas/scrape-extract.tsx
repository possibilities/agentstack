"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CircleCheckIcon, CircleXIcon, GlobeIcon, LinkIcon, PlayIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { driftedPreset, failureLabels, presetPreview, scrapeCallError, scrapeLocalReason, type CallError } from "@/lib/stack/scrape";
import type { ScrapeEnvelope, ScrapeLinks, ScrapePreset } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty, NodeLink, StatusDot, Time, type Tone } from "./primitives";
import { useStack, useStore } from "./provider";
import { CallErrorNote, EgressConsent, Elapsed, fieldLabel, Raw, renderLimit, ScrapeMarkdown } from "./scrape-shared";
import { Section, Window } from "./window";

type Mode = "page" | "links";
type Inputs = {
  url: string; preset: string; selector: string; media: "" | "light" | "dark"; session: string; maxContentBytes: string; maxRelations: string;
  limit: string; maxScrolls: string; sinceId: string; includeReplies: boolean; includeReposts: boolean; sectionSelector: string; categorySelector: string; toggleSelector: string;
};
type Outcome = { kind: "page"; envelope: ScrapeEnvelope } | { kind: "links"; value: ScrapeLinks } | { kind: "error"; error: CallError };
type Run = { id: string; mode: Mode; inputs: Inputs; startedAt: number; finishedAt: number; outcome: Outcome | null; tone: Tone; summary: string };

/** The preset select's value for forcing generic extraction on a claimed host. */
const generic = "generic";
const keptRuns = 20;
/** Only the newest runs keep their (possibly large) results; older ones restore inputs only. */
const keptResults = 5;
const blank: Inputs = { url: "", preset: "", selector: "", media: "", session: "", maxContentBytes: "", maxRelations: "", limit: "", maxScrolls: "",
  sinceId: "", includeReplies: false, includeReposts: false, sectionSelector: "", categorySelector: "", toggleSelector: "" };

/** Mirrors scrape_fetch and scrape_links input bounds. */
const bounds = { maxContentBytes: 5_000_000, maxRelations: 2_048 };

function positive(value: string, max: number, allowZero = false): number | undefined | null {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= (allowZero ? 0 : 1) && number <= max ? number : null;
}

function buildArgs(mode: Mode, inputs: Inputs, consent: boolean): { args: Record<string, unknown> } | { invalid: string } {
  const text = (value: string) => value.trim() || undefined;
  const common = { url: inputs.url.trim(), media: inputs.media || undefined, session: text(inputs.session), allowPrivateNetwork: consent };
  if (mode === "page") {
    const maxContentBytes = positive(inputs.maxContentBytes, bounds.maxContentBytes);
    const maxRelations = positive(inputs.maxRelations, bounds.maxRelations, true);
    if (maxContentBytes === null) return { invalid: `Content limit must be 1–${bounds.maxContentBytes.toLocaleString()} bytes` };
    if (maxRelations === null) return { invalid: `Relation limit must be 0–${bounds.maxRelations.toLocaleString()}` };
    return { args: { ...common, preset: inputs.preset && inputs.preset !== generic ? inputs.preset : undefined, generic: inputs.preset === generic || undefined,
      selector: text(inputs.selector), maxContentBytes, maxRelations } };
  }
  const limit = positive(inputs.limit, Number.MAX_SAFE_INTEGER);
  const maxScrolls = positive(inputs.maxScrolls, Number.MAX_SAFE_INTEGER);
  if (limit === null || maxScrolls === null) return { invalid: "Limits must be positive whole numbers" };
  if (inputs.sinceId.trim() && !/^\d+$/.test(inputs.sinceId.trim())) return { invalid: "Since ID must be a numeric post ID" };
  return { args: { ...common, preset: inputs.preset && inputs.preset !== generic ? inputs.preset : undefined, limit, maxScrolls, sinceId: text(inputs.sinceId),
    includeReplies: inputs.includeReplies || undefined, includeReposts: inputs.includeReposts || undefined,
    sectionSelector: text(inputs.sectionSelector), categorySelector: text(inputs.categorySelector), toggleSelector: text(inputs.toggleSelector) } };
}

function summarize(outcome: Outcome): { tone: Tone; summary: string } {
  if (outcome.kind === "error") return { tone: outcome.error.uncertain ? "warning" : "destructive", summary: outcome.error.text };
  if (outcome.kind === "links") return { tone: "success", summary: `${outcome.value.links?.length ?? 0} links` };
  const { envelope } = outcome;
  if (envelope.failure) return { tone: "destructive", summary: failureLabels[envelope.failure.failure_class] };
  const bytes = envelope.artifacts.reduce((sum, item) => sum + item.size_bytes, 0);
  return { tone: "success", summary: `${envelope.metadata?.title || "Extracted"} · ${formatBytes(bytes)}` };
}

export function formatBytes(bytes: number): string {
  return bytes < 1_024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1_024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function urlLabel(value: string): string {
  try { const url = new URL(value); return `${url.host}${url.pathname === "/" ? "" : url.pathname}`; } catch { return value; }
}

/**
 * Scrape's extraction workbench: `scrape_fetch` for a page's content envelope and `scrape_links`
 * for navigation links or an X timeline. Both are synchronous and may drive a browser for minutes;
 * a failure is shown with its class and never retried. Recent runs are kept for this page only.
 */
export function ExtractWindow() {
  const store = useStore();
  const { status, endpoints, scrapePresets, remote, scrapeCompose } = useStack();
  const formId = useId();
  const [mode, setMode] = useState<Mode>("page");
  const [inputs, setInputs] = useState<Inputs>(blank);
  const [consent, setConsent] = useState(false);
  const [options, setOptions] = useState(false);
  const [running, setRunning] = useState<{ startedAt: number; mode: Mode; url: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const presets = useMemo(() => scrapePresets.data ?? [], [scrapePresets.data]);
  const set = (patch: Partial<Inputs>) => { setInputs((current) => ({ ...current, ...patch })); setInvalid(null); };

  // Another window (Presets) asked to try a preset here.
  useEffect(() => {
    if (!scrapeCompose) return;
    setMode(scrapeCompose.mode);
    setInputs((current) => ({ ...current, preset: scrapeCompose.preset }));
  }, [scrapeCompose]);

  const blocked = scrapeLocalReason(remote) ?? (!endpoints.scrape ? "Scrape isn't served by this server" : status.scrape !== "open" ? "Scrape reconnecting" : null);
  const preview = inputs.preset === "" && inputs.url.trim() ? presetPreview(inputs.url, presets) : null;
  const run = runs.find((item) => item.id === shown) ?? null;

  const submit = async () => {
    if (blocked || running) return;
    if (preview?.kind === "invalid") { setInvalid("Enter an http or https URL without credentials"); return; }
    const built = buildArgs(mode, inputs, consent);
    if ("invalid" in built) { setInvalid(built.invalid); return; }
    const startedAt = Date.now();
    const snapshot = { ...inputs };
    setRunning({ startedAt, mode, url: snapshot.url.trim() });
    setConsent(false);
    let outcome: Outcome;
    try {
      outcome = mode === "page"
        ? { kind: "page", envelope: await store.call<ScrapeEnvelope>("scrape", "scrape_fetch", built.args) }
        : { kind: "links", value: await store.call<ScrapeLinks>("scrape", "scrape_links", built.args) };
    } catch (error) {
      outcome = { kind: "error", error: scrapeCallError(error) };
    }
    const id = crypto.randomUUID();
    setRuns((list) => [{ id, mode, inputs: snapshot, startedAt, finishedAt: Date.now(), outcome, ...summarize(outcome) }, ...list].slice(0, keptRuns)
      .map((item, index) => index < keptResults ? item : { ...item, outcome: null }));
    setShown(id);
    setRunning(null);
  };

  const restore = (item: Run) => {
    setMode(item.mode);
    setInputs(item.inputs);
    setInvalid(null);
    if (item.outcome) setShown(item.id);
  };

  return (
    <Window id="scrape-extract" title="Extract" icon={GlobeIcon} accent="scrape" status={endpoints.scrape ? status.scrape : undefined} endpoint={endpoints.scrape}
      updatedAt={scrapePresets.at} error={scrapePresets.error} empty={!endpoints.scrape}>
      {!endpoints.scrape ? <Empty icon={GlobeIcon} title="Scrape isn't served by this server" /> : (
        <>
          <form id={formId} className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="flex items-center gap-2">
              <ToggleGroup value={[mode]} onValueChange={(value: string[]) => { if (value.length) { setMode(value[0] as Mode); setInvalid(null); } }} spacing={0} size="sm" variant="outline" aria-label="Extract">
                <ToggleGroupItem value="page">Page</ToggleGroupItem>
                <ToggleGroupItem value="links">Links</ToggleGroupItem>
              </ToggleGroup>
              <label htmlFor={`${formId}-url`} className="sr-only">URL</label>
              <Input id={`${formId}-url`} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://…" value={inputs.url}
                disabled={Boolean(running)} aria-invalid={invalid ? true : undefined} onChange={(event) => set({ url: event.target.value })} className="min-w-0 flex-1 font-mono text-[0.78rem]" />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor={`${formId}-preset`} className={fieldLabel}>Preset</label>
              <NativeSelect id={`${formId}-preset`} size="sm" className="min-w-0 flex-1" value={inputs.preset} disabled={Boolean(running)} onChange={(event) => set({ preset: event.target.value })}>
                <NativeSelectOption value="">Automatic</NativeSelectOption>
                {mode === "page" ? <NativeSelectOption value={generic}>Generic (no preset)</NativeSelectOption> : null}
                {presets.map((preset) => <NativeSelectOption key={preset.name} value={preset.name}>{preset.name} · {preset.mode}</NativeSelectOption>)}
              </NativeSelect>
              <Button type="button" size="sm" variant={options ? "secondary" : "ghost"} aria-expanded={options} onClick={() => setOptions(!options)}>
                <SlidersHorizontalIcon data-icon="inline-start" />Options
              </Button>
            </div>
            {preview ? <PresetHint preview={preview} /> : null}
            {options ? <Options mode={mode} inputs={inputs} set={set} disabled={Boolean(running)} formId={formId} /> : null}
            <EgressConsent checked={consent} onChange={setConsent} disabled={Boolean(running) || Boolean(blocked)} />
            {invalid ? <p role="alert" className="px-0.5 text-[0.72rem] text-destructive">{invalid}</p> : null}
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[0.68rem] text-pretty text-muted-foreground">
                {running ? <>{running.mode === "page" ? "Extracting" : "Reading links"} · <Elapsed since={running.startedAt} /> · browser pages can take minutes and can't be cancelled here</>
                  : blocked ?? "Enter to run · results are untrusted web content"}
              </span>
              <Button type="submit" size="sm" disabled={Boolean(blocked) || Boolean(running) || !inputs.url.trim()} title={blocked ?? undefined}>
                {running ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}Run
              </Button>
            </div>
          </form>
          {run?.outcome ? <Result run={run} presets={presets} /> : null}
          {runs.length ? (
            <Section title="Recent" aside={<span className="text-[0.65rem] text-muted-foreground">This page only</span>}>
              <ul className="flex flex-col gap-0.5">
                {runs.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => restore(item)} aria-current={item.id === shown ? "true" : undefined}
                      title={item.outcome ? "Show this result and restore its inputs" : "Restore its inputs; the result is no longer kept"}
                      className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", item.id === shown && "bg-muted")}>
                      <StatusDot tone={item.tone} />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate font-mono text-[0.72rem]">{urlLabel(item.inputs.url)}</span>
                        <span className="truncate text-[0.66rem] text-muted-foreground">{item.mode === "page" ? "Page" : "Links"} · {item.summary}</span>
                      </span>
                      <span className="shrink-0 text-[0.65rem] text-muted-foreground tabular-nums">{((item.finishedAt - item.startedAt) / 1_000).toFixed(1)}s · <Time at={item.finishedAt} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </>
      )}
    </Window>
  );
}

function PresetHint({ preview }: { preview: ReturnType<typeof presetPreview> }) {
  const text = "px-0.5 text-[0.7rem] text-pretty text-muted-foreground";
  if (preview.kind === "invalid") return <p className={text}>Enter an http or https URL.</p>;
  if (preview.kind === "generic") return <p className={text}>No preset claims this host; generic extraction.</p>;
  if (preview.kind === "claimed") return (
    <p className={cn(text, "text-warning")}><TriangleAlertIcon className="mr-1 inline size-3" />
      Presets claim {preview.domain}, but none matches this URL, so it will fail rather than fall back. Choose Generic to force generic extraction.
    </p>
  );
  return (
    <p className={text}>
      Likely preset{preview.presets.length > 1 ? "s" : ""}: {preview.presets.map((name, index) => (
        <span key={name}>{index ? ", " : ""}<NodeLink node={{ kind: "preset", id: name }} label={name} className="font-mono text-foreground">{name}</NodeLink></span>
      ))}{preview.presets.length > 1 ? " — ambiguous; choose one" : ""} · preview, Scrape decides
    </p>
  );
}

function Options({ mode, inputs, set, disabled, formId }: { mode: Mode; inputs: Inputs; set(patch: Partial<Inputs>): void; disabled: boolean; formId: string }) {
  const field = (key: keyof Inputs, label: string, placeholder: string, props: React.ComponentProps<typeof Input> = {}) => (
    <label className="flex flex-col gap-1">
      <span className={fieldLabel}>{label}</span>
      <Input value={String(inputs[key])} placeholder={placeholder} disabled={disabled} spellCheck={false} autoComplete="off"
        onChange={(event) => set({ [key]: event.target.value } as Partial<Inputs>)} className="h-7 font-mono text-[0.74rem]" {...props} />
    </label>
  );
  const toggle = (key: "includeReplies" | "includeReposts", label: string) => (
    <label htmlFor={`${formId}-${key}`} className="flex items-center gap-2 text-[0.74rem]">
      <Switch id={`${formId}-${key}`} size="sm" checked={inputs[key]} disabled={disabled} onCheckedChange={(checked) => set({ [key]: checked } as Partial<Inputs>)} />{label}
    </label>
  );
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border p-2.5">
      {mode === "page" ? (
        <>
          {field("selector", "Selector", "article main")}
          {field("session", "Browser session", "signed-in session name")}
          {field("maxContentBytes", "Content limit (bytes)", "default", { inputMode: "numeric" })}
          {field("maxRelations", "Relation limit", "default", { inputMode: "numeric" })}
        </>
      ) : (
        <>
          {field("limit", "Limit", "default", { inputMode: "numeric" })}
          {field("maxScrolls", "Max scrolls", "default", { inputMode: "numeric" })}
          {field("sinceId", "Since post ID", "X timelines", { inputMode: "numeric" })}
          {field("session", "Browser session", "signed-in session name")}
          {field("sectionSelector", "Section selector", "nav presets")}
          {field("categorySelector", "Category selector", "nav presets")}
          {field("toggleSelector", "Toggle selector", "nav presets")}
          <div className="flex flex-col justify-end gap-1.5">{toggle("includeReplies", "Replies")}{toggle("includeReposts", "Reposts")}</div>
        </>
      )}
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>Color scheme</span>
        <NativeSelect size="sm" value={inputs.media} disabled={disabled} onChange={(event) => set({ media: event.target.value as Inputs["media"] })}>
          <NativeSelectOption value="">Default</NativeSelectOption>
          <NativeSelectOption value="light">Light</NativeSelectOption>
          <NativeSelectOption value="dark">Dark</NativeSelectOption>
        </NativeSelect>
      </label>
      <p className="col-span-2 px-0.5 text-[0.66rem] text-pretty text-muted-foreground">A browser session reuses an operator-established sign-in; Scrape never signs in and never closes it.</p>
    </div>
  );
}

type View = "rendered" | "markdown" | "relations" | "raw";

function Result({ run, presets }: { run: Run; presets: ScrapePreset[] }) {
  const [view, setView] = useState<View>("rendered");
  const outcome = run.outcome!;
  if (outcome.kind === "error") return <CallErrorNote error={outcome.error} />;
  const markdown = outcome.kind === "page" ? outcome.envelope.artifacts.map((item) => item.content).join("\n\n") : outcome.value.markdown;
  const related = outcome.kind === "page" ? outcome.envelope.relations.map((item) => item.target_url) : (outcome.value.links ?? []);
  const raw = outcome.kind === "page"
    ? JSON.stringify({ ...outcome.envelope, artifacts: outcome.envelope.artifacts.map((item) => ({ ...item, content: `<${item.size_bytes.toLocaleString()} bytes; see Markdown>` })) }, null, 2)
    : JSON.stringify(outcome.value.structured, null, 2);
  const failed = outcome.kind === "page" && outcome.envelope.failure;
  return (
    <Section title="Result" aside={<span className="text-[0.65rem] text-muted-foreground">Untrusted web content</span>}>
      {outcome.kind === "page" ? <EnvelopeSummary envelope={outcome.envelope} presets={presets} /> : null}
      {failed ? null : (
        <>
          <div className="flex items-center gap-2">
            <ToggleGroup value={[view]} onValueChange={(value: string[]) => { if (value.length) setView(value[0] as View); }} spacing={0} size="sm" variant="outline" aria-label="Result view">
              <ToggleGroupItem value="rendered">Rendered</ToggleGroupItem>
              <ToggleGroupItem value="markdown">Markdown</ToggleGroupItem>
              <ToggleGroupItem value="relations">{outcome.kind === "page" ? "Relations" : "Links"} {related.length}</ToggleGroupItem>
              <ToggleGroupItem value="raw">{outcome.kind === "page" ? "Envelope" : "Structured"}</ToggleGroupItem>
            </ToggleGroup>
            <CopyButton value={view === "raw" ? raw : markdown} label={view === "raw" ? "JSON" : "Markdown"} className="ml-auto opacity-100" />
          </div>
          {view === "rendered" ? (markdown.trim() ? <div className="rounded-lg border p-3"><ScrapeMarkdown text={markdown} /></div> : <Empty icon={GlobeIcon} title="No Markdown" />)
            : view === "markdown" ? <Raw value={markdown.length > renderLimit * 2 ? `${markdown.slice(0, renderLimit * 2)}\n…` : markdown} />
            : view === "relations" ? <RelatedList items={related} />
            : <Raw value={raw} />}
        </>
      )}
    </Section>
  );
}

function EnvelopeSummary({ envelope, presets }: { envelope: ScrapeEnvelope; presets: ScrapePreset[] }) {
  const bytes = envelope.artifacts.reduce((sum, item) => sum + item.size_bytes, 0);
  const sha = envelope.artifacts[0]?.sha256;
  const meta = envelope.metadata;
  const drifted = driftedPreset(envelope.failure, envelope.extractor.implementation, presets);
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.74rem]">
        {envelope.failure ? <CircleXIcon className="size-3.5 text-destructive" /> : <CircleCheckIcon className="size-3.5 text-success" />}
        <span className="font-medium">{envelope.failure ? failureLabels[envelope.failure.failure_class] : "Extracted"}</span>
        <span className="font-mono text-[0.68rem] text-muted-foreground" title={`${envelope.extractor.name} ${envelope.extractor.version}`}>
          {envelope.extractor.implementation} {envelope.extractor.implementation_version}
        </span>
        {envelope.failure ? null : <span className="text-muted-foreground tabular-nums">{formatBytes(bytes)}</span>}
        {sha ? <span className="flex items-center font-mono text-[0.66rem] text-muted-foreground" title={sha}>sha {sha.slice(0, 10)}<CopyButton value={sha} label="SHA-256" className="opacity-100" /></span> : null}
      </div>
      {envelope.final_url && envelope.final_url !== envelope.requested_url ? (
        <p className="truncate font-mono text-[0.68rem] text-muted-foreground" title={envelope.final_url}>→ {envelope.final_url}</p>
      ) : null}
      {meta ? (
        <div className="flex flex-col gap-0.5 border-t pt-2 text-[0.74rem]">
          {meta.title ? <p className="font-medium text-pretty">{meta.title}</p> : null}
          <p className="flex flex-wrap gap-x-2 text-[0.68rem] text-muted-foreground">
            {meta.author_name || meta.author_handle ? <span>{meta.author_name}{meta.author_handle ? ` @${meta.author_handle.replace(/^@/, "")}` : ""}</span> : null}
            {meta.published_at ? <span>{meta.published_at}</span> : null}
            <span>{meta.content_kind ?? meta.content_type}{meta.content_item_count ? ` · ${meta.content_item_count} items` : ""}</span>
            {meta.warnings.includes("partial_content") ? <span className="text-warning">partial content</span> : null}
            <span title="Metadata is what the page reported; it is not verified">reported by the page</span>
          </p>
        </div>
      ) : null}
      {envelope.failure ? (
        <div className="flex flex-col gap-1.5 border-t pt-2 text-[0.74rem]">
          <p className="text-pretty">{envelope.failure.message}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-[0.68rem] text-muted-foreground">
            <span className="font-mono">{envelope.failure.failure_class}</span>
            <span>{envelope.failure.retryable ? "retryable" : "not retryable"}</span>
            {drifted ? <span>· <NodeLink node={{ kind: "preset", id: drifted }} label={drifted} className="font-mono text-foreground">Review {drifted}</NodeLink></span> : null}
          </p>
          {envelope.failure.evidence ? (
            <details>
              <summary className="cursor-pointer text-[0.68rem] text-muted-foreground">Evidence</summary>
              <Raw value={envelope.failure.evidence} className="mt-1.5" />
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RelatedList({ items }: { items: unknown[] }) {
  if (!items.length) return <Empty icon={LinkIcon} title="None" />;
  return (
    <ul className="flex max-h-96 flex-col gap-0.5 overflow-auto">
      {items.map((item, index) => {
        const href = typeof item === "string" ? item : typeof item === "object" && item && "url" in item ? String((item as { url: unknown }).url) : null;
        const label = typeof item === "object" && item && "text" in item ? String((item as { text: unknown }).text) : null;
        let safe: string | null = null;
        try { safe = href && ["http:", "https:"].includes(new URL(href).protocol) ? href : null; } catch { safe = null; }
        return (
          <li key={index} className="flex min-w-0 flex-col rounded-md px-1.5 py-1 text-[0.72rem] hover:bg-muted/70">
            {label ? <span className="truncate">{label}</span> : null}
            {safe ? <a href={safe} target="_blank" rel="noreferrer noopener" className="truncate font-mono text-[0.68rem] text-muted-foreground hover:text-foreground hover:underline">{safe}</a>
              : <span className="truncate font-mono text-[0.68rem] text-muted-foreground">{href ?? JSON.stringify(item)}</span>}
          </li>
        );
      })}
    </ul>
  );
}
