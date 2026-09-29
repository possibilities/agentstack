"use client";

import { useId, useState } from "react";
import { ArrowRightLeftIcon, CircleCheckIcon, CircleXIcon, RefreshCwIcon, RssIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { scrapeCallError, scrapeLocalReason, type CallError } from "@/lib/stack/scrape";
import type { ScrapeFeed } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty } from "./primitives";
import { useStack, useStore } from "./provider";
import { CallErrorNote, Elapsed, fieldLabel, Raw, ScrapeMarkdown } from "./scrape-shared";
import { Section, Window } from "./window";

type Kind = "auto" | "feed" | "archive";
type Discover = { sourceUrl: string; sourceKind: Kind; since: string; maxPages: string; maxItems: string; timeoutSeconds: string;
  entrySelector: string; linkSelector: string; titleSelector: string; dateSelector: string; nextSelector: string };
type Conditional = { etag: string | null; lastModified: string | null; validatorUrl: string };
type Outcome = { feed: ScrapeFeed; args: Record<string, unknown>; parsed: boolean } | { error: CallError };

/** Mirrors scrape_feed_discover's bounds; the WebSocket gateway waits a little longer than the largest timeout. */
const limits = { maxPages: 10, maxItems: 10_000, timeoutSeconds: 300, content: 20_000_000 };
const blank: Discover = { sourceUrl: "", sourceKind: "auto", since: "", maxPages: "", maxItems: "", timeoutSeconds: "", entrySelector: "", linkSelector: "", titleSelector: "", dateSelector: "", nextSelector: "" };

function bounded(value: string, max: number, integer = true): number | undefined | null {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max && (!integer || Number.isInteger(number)) ? number : null;
}

function discoverArgs(input: Discover): { args: Record<string, unknown> } | { invalid: string } {
  const maxPages = bounded(input.maxPages, limits.maxPages);
  const maxItems = bounded(input.maxItems, limits.maxItems);
  const timeoutSeconds = bounded(input.timeoutSeconds, limits.timeoutSeconds, false);
  if (maxPages === null) return { invalid: `Pages must be 1–${limits.maxPages}` };
  if (maxItems === null) return { invalid: `Items must be 1–${limits.maxItems.toLocaleString()}` };
  if (timeoutSeconds === null) return { invalid: `Timeout must be up to ${limits.timeoutSeconds}s` };
  const text = (value: string) => value.trim() || undefined;
  if (input.sourceKind === "archive" && !input.entrySelector.trim()) return { invalid: "An archive needs an entry selector" };
  const archive = input.entrySelector.trim() ? { entrySelector: input.entrySelector.trim(), linkSelector: text(input.linkSelector), titleSelector: text(input.titleSelector),
    dateSelector: text(input.dateSelector), nextSelector: text(input.nextSelector) } : undefined;
  return { args: { sourceUrl: input.sourceUrl.trim(), sourceKind: input.sourceKind, since: text(input.since), maxPages, maxItems, timeoutSeconds, archive } };
}

/** Validators bind to the exact page URL that returned them. */
function conditionalFor(feed: ScrapeFeed): Conditional | null {
  const page = feed.pagination.pages[0];
  const validators = page?.validators ?? feed.validators;
  if (!page || (!validators.etag && !validators.last_modified)) return null;
  return { etag: validators.etag, lastModified: validators.last_modified, validatorUrl: page.url };
}

/**
 * Feed and archive discovery over direct public HTTP (`scrape_feed_discover`), a conditional
 * re-check bound to the returned validators, and offline parsing of pasted pages
 * (`scrape_feed_parse`). An item missing from a result never means it was deleted.
 */
export function FeedsWindow() {
  const store = useStore();
  const { status, endpoints, remote } = useStack();
  const formId = useId();
  const [tab, setTab] = useState<"discover" | "parse">("discover");
  const [input, setInput] = useState<Discover>(blank);
  const [archive, setArchive] = useState(false);
  const [recorded, setRecorded] = useState({ url: "", kind: "auto" as Kind, content: "" });
  const [running, setRunning] = useState<number | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const connected = status.scrape === "open";
  const offline = !endpoints.scrape ? "Scrape isn't served by this server" : !connected ? "Scrape reconnecting" : null;
  // Discovery reaches the network; parsing recorded pages is read-only and offline.
  const blocked = tab === "discover" ? scrapeLocalReason(remote) ?? offline : offline;
  const set = (patch: Partial<Discover>) => { setInput((current) => ({ ...current, ...patch })); setInvalid(null); };

  const call = async (name: "scrape_feed_discover" | "scrape_feed_parse", args: Record<string, unknown>) => {
    setRunning(Date.now());
    try {
      setOutcome({ feed: await store.call<ScrapeFeed>("scrape", name, args), args, parsed: name === "scrape_feed_parse" });
    } catch (error) {
      setOutcome({ error: scrapeCallError(error) });
    } finally {
      setRunning(null);
    }
  };

  const submit = () => {
    if (blocked || running) return;
    if (tab === "discover") {
      const built = discoverArgs(input);
      if ("invalid" in built) { setInvalid(built.invalid); return; }
      void call("scrape_feed_discover", built.args);
    } else {
      if (!recorded.url.trim() || !recorded.content.trim()) { setInvalid("Enter the page URL and its content"); return; }
      if (recorded.content.length > limits.content) { setInvalid("Content exceeds 20 MB"); return; }
      const options = { sourceUrl: recorded.url.trim(), sourceKind: recorded.kind };
      void call("scrape_feed_parse", { options, initial: { url: recorded.url.trim(), content: recorded.content, kind: recorded.kind } });
    }
  };

  const recheck = (feedOutcome: { feed: ScrapeFeed; args: Record<string, unknown> }) => {
    const conditional = conditionalFor(feedOutcome.feed);
    if (!conditional || blocked || running) return;
    void call("scrape_feed_discover", { ...feedOutcome.args, etag: conditional.etag ?? undefined, lastModified: conditional.lastModified ?? undefined, validatorUrl: conditional.validatorUrl });
  };

  const field = (key: keyof Discover, label: string, placeholder: string, numeric = false) => (
    <label className="flex flex-col gap-1">
      <span className={fieldLabel}>{label}</span>
      <Input value={input[key]} placeholder={placeholder} disabled={Boolean(running)} spellCheck={false} autoComplete="off" inputMode={numeric ? "numeric" : undefined}
        onChange={(event) => set({ [key]: event.target.value } as Partial<Discover>)} className="h-7 font-mono text-[0.74rem]" />
    </label>
  );

  return (
    <Window id="scrape-feeds" title="Feeds" icon={RssIcon} accent="scrape" status={endpoints.scrape ? status.scrape : undefined} endpoint={endpoints.scrape} empty={!endpoints.scrape}>
      {!endpoints.scrape ? <Empty icon={RssIcon} title="Scrape isn't served by this server" /> : (
        <>
          <form id={formId} className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <ToggleGroup value={[tab]} onValueChange={(value: string[]) => { if (value.length) { setTab(value[0] as "discover" | "parse"); setInvalid(null); } }} spacing={0} size="sm" variant="outline" aria-label="Feed source">
              <ToggleGroupItem value="discover">Discover</ToggleGroupItem>
              <ToggleGroupItem value="parse">Parse recorded</ToggleGroupItem>
            </ToggleGroup>
            {tab === "discover" ? (
              <>
                <div className="flex items-center gap-2">
                  <label htmlFor={`${formId}-source`} className="sr-only">Site, feed or archive URL</label>
                  <Input id={`${formId}-source`} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://example.com/blog" value={input.sourceUrl}
                    disabled={Boolean(running)} onChange={(event) => set({ sourceUrl: event.target.value })} className="min-w-0 flex-1 font-mono text-[0.78rem]" />
                  <NativeSelect size="sm" aria-label="Source kind" value={input.sourceKind} disabled={Boolean(running)}
                    onChange={(event) => { set({ sourceKind: event.target.value as Kind }); if (event.target.value === "archive") setArchive(true); }}>
                    <NativeSelectOption value="auto">Auto</NativeSelectOption>
                    <NativeSelectOption value="feed">Feed</NativeSelectOption>
                    <NativeSelectOption value="archive">Archive</NativeSelectOption>
                  </NativeSelect>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {field("maxPages", "Pages", "≤ 10", true)}
                  {field("maxItems", "Items", "default", true)}
                  {field("timeoutSeconds", "Timeout s", "10", true)}
                  {field("since", "Since", "ISO date")}
                </div>
                <details open={archive} onToggle={(event) => setArchive(event.currentTarget.open)} className="rounded-lg border px-2.5 py-1.5">
                  <summary className="cursor-pointer text-[0.72rem] text-muted-foreground">HTML archive selectors</summary>
                  <div className="grid grid-cols-2 gap-2 py-2">
                    {field("entrySelector", "Entry", "article")}
                    {field("linkSelector", "Link", "a")}
                    {field("titleSelector", "Title", "h2")}
                    {field("dateSelector", "Date", "time")}
                    {field("nextSelector", "Next page", "a[rel=next]")}
                  </div>
                </details>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <label htmlFor={`${formId}-recorded-url`} className="sr-only">URL the content came from</label>
                  <Input id={`${formId}-recorded-url`} type="url" autoComplete="off" spellCheck={false} placeholder="URL the content came from" value={recorded.url} disabled={Boolean(running)}
                    onChange={(event) => { setRecorded({ ...recorded, url: event.target.value }); setInvalid(null); }} className="min-w-0 flex-1 font-mono text-[0.78rem]" />
                  <NativeSelect size="sm" aria-label="Content kind" value={recorded.kind} disabled={Boolean(running)} onChange={(event) => setRecorded({ ...recorded, kind: event.target.value as Kind })}>
                    <NativeSelectOption value="auto">Auto</NativeSelectOption>
                    <NativeSelectOption value="feed">Feed</NativeSelectOption>
                    <NativeSelectOption value="archive">Archive</NativeSelectOption>
                  </NativeSelect>
                </div>
                <label htmlFor={`${formId}-recorded`} className="sr-only">Recorded RSS, Atom or HTML</label>
                <Textarea id={`${formId}-recorded`} value={recorded.content} disabled={Boolean(running)} placeholder="Paste recorded RSS, Atom or archive HTML"
                  onChange={(event) => { setRecorded({ ...recorded, content: event.target.value }); setInvalid(null); }} className="max-h-48 min-h-24 font-mono text-[0.72rem]" />
              </>
            )}
            {invalid ? <p role="alert" className="px-0.5 text-[0.72rem] text-destructive">{invalid}</p> : null}
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[0.68rem] text-pretty text-muted-foreground">
                {running ? <>{tab === "discover" ? "Discovering" : "Parsing"} · <Elapsed since={running} /></>
                  : blocked ?? (tab === "discover" ? "Direct public HTTP only; no browser" : "Offline; nothing is fetched")}
              </span>
              <Button type="submit" size="sm" disabled={Boolean(blocked) || Boolean(running)} title={blocked ?? undefined}>
                {running ? <Spinner data-icon="inline-start" /> : <SearchIcon data-icon="inline-start" />}{tab === "discover" ? "Discover" : "Parse"}
              </Button>
            </div>
          </form>
          {outcome ? ("error" in outcome ? <CallErrorNote error={outcome.error} /> : (
            <FeedResult feed={outcome.feed} recheck={!outcome.parsed && conditionalFor(outcome.feed) && !blocked && !running ? () => recheck(outcome) : null} />
          )) : null}
        </>
      )}
    </Window>
  );
}

function FeedResult({ feed, recheck }: { feed: ScrapeFeed; recheck: (() => void) | null }) {
  const notModified = feed.pagination.stop_reason === "not_modified";
  return (
    <Section title="Result" aside={recheck ? (
      <Button type="button" size="xs" variant="outline" onClick={recheck} title="Repeat with the returned validators; unchanged sources answer Not modified">
        <RefreshCwIcon data-icon="inline-start" />Check for newer
      </Button>
    ) : null}>
      <div className="flex flex-col gap-1.5 rounded-lg border p-2.5 text-[0.74rem]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {feed.status === "failure" ? <CircleXIcon className="size-3.5 text-destructive" /> : feed.status === "partial" ? <TriangleAlertIcon className="size-3.5 text-warning" /> : <CircleCheckIcon className="size-3.5 text-success" />}
          <span className="font-medium">{notModified ? "Not modified" : feed.status === "success" ? "Complete" : feed.status === "partial" ? "Partial" : "Failed"}</span>
          <span className="text-muted-foreground">{feed.source_format} · {feed.items.length} items · {feed.pagination.pages.length} page{feed.pagination.pages.length === 1 ? "" : "s"}</span>
          <span className="font-mono text-[0.66rem] text-muted-foreground">stop: {feed.pagination.stop_reason}</span>
        </p>
        {feed.failure ? <p className="text-destructive text-pretty">{feed.failure.message} <span className="font-mono text-[0.66rem]">{feed.failure.code}{feed.failure.retryable ? " · retryable" : ""}</span></p> : null}
        {feed.warnings.map((warning, index) => (
          <p key={index} className="text-warning text-pretty"><span className="font-mono text-[0.66rem]">{warning.code}</span> {warning.message}</p>
        ))}
        {feed.pagination.next_url ? <p className="truncate font-mono text-[0.66rem] text-muted-foreground" title={feed.pagination.next_url}>next: {feed.pagination.next_url}</p> : null}
        <p className="text-[0.66rem] text-muted-foreground">An item missing here does not mean it was deleted upstream.</p>
      </div>
      {feed.items.length ? (
        <ul className="flex max-h-[28rem] flex-col gap-0.5 overflow-auto">
          {feed.items.map((item) => (
            <li key={item.stable_id} className={cn("flex min-w-0 flex-col rounded-md px-1.5 py-1 hover:bg-muted/70", item.tombstone && "opacity-60")}>
              <span className={cn("truncate text-[0.76rem]", item.tombstone && "line-through")} title={item.title}>{item.title || "Untitled"}</span>
              <span className="flex min-w-0 gap-2 text-[0.66rem] text-muted-foreground">
                {item.published_at ? <span className="shrink-0 tabular-nums">{item.published_at.slice(0, 10)}</span> : null}
                {item.updated_at && item.updated_at !== item.published_at ? <span className="shrink-0 tabular-nums">updated {item.updated_at.slice(0, 10)}</span> : null}
                {item.url ? <a href={item.url} target="_blank" rel="noreferrer noopener" className="truncate font-mono hover:text-foreground hover:underline">{item.url}</a> : null}
                <span className="ml-auto shrink-0" title={`Identity from ${item.identity_source.replaceAll("_", " ")}`}>{item.identity_source === "upstream_id" ? "id" : item.identity_source === "canonical_url" ? "url" : "hash"}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary className="cursor-pointer px-0.5 text-[0.68rem] text-muted-foreground">Pages, validators and cursor</summary>
        <Raw className="mt-1.5" value={JSON.stringify({ validators: feed.validators, cursor: feed.cursor, pages: feed.pagination.pages }, null, 2)} />
      </details>
    </Section>
  );
}

/** Offline HTML → Markdown with `scrape_convert_html`; nothing is fetched or written. */
export function ConvertWindow() {
  const store = useStore();
  const { status, endpoints } = useStack();
  const formId = useId();
  const [html, setHtml] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ markdown: string } | { error: CallError } | null>(null);
  const [view, setView] = useState<"rendered" | "markdown">("markdown");
  const blocked = !endpoints.scrape ? "Scrape isn't served by this server" : status.scrape !== "open" ? "Scrape reconnecting" : null;
  const tooLarge = html.length > 8_000_000;
  const convert = async () => {
    if (blocked || running || !html.trim() || tooLarge) return;
    setRunning(true);
    try { setResult(await store.call<{ markdown: string }>("scrape", "scrape_convert_html", { html })); }
    catch (error) { setResult({ error: scrapeCallError(error) }); }
    finally { setRunning(false); }
  };
  return (
    <Window id="scrape-convert" title="Convert" icon={ArrowRightLeftIcon} accent="scrape" status={endpoints.scrape ? status.scrape : undefined} endpoint={endpoints.scrape} empty={!endpoints.scrape}>
      {!endpoints.scrape ? <Empty icon={ArrowRightLeftIcon} title="Scrape isn't served by this server" /> : (
        <>
          <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void convert(); }}>
            <label htmlFor={`${formId}-html`} className="sr-only">HTML</label>
            <Textarea id={`${formId}-html`} value={html} placeholder="Paste HTML" onChange={(event) => { setHtml(event.target.value); }}
              onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void convert(); } }}
              className="max-h-48 min-h-24 font-mono text-[0.72rem]" />
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[0.68rem] text-muted-foreground">{tooLarge ? "HTML exceeds 8 MB" : blocked ?? "⌘Enter to convert · offline"}</span>
              <Button type="submit" size="sm" disabled={Boolean(blocked) || running || !html.trim() || tooLarge}>
                {running ? <Spinner data-icon="inline-start" /> : <ArrowRightLeftIcon data-icon="inline-start" />}Convert
              </Button>
            </div>
          </form>
          {result ? ("error" in result ? <CallErrorNote error={result.error} /> : (
            <Section title="Markdown" aside={<CopyButton value={result.markdown} label="Markdown" className="opacity-100" />}>
              <ToggleGroup value={[view]} onValueChange={(value: string[]) => { if (value.length) setView(value[0] as "rendered" | "markdown"); }} spacing={0} size="sm" variant="outline" aria-label="Markdown view">
                <ToggleGroupItem value="markdown">Markdown</ToggleGroupItem>
                <ToggleGroupItem value="rendered">Rendered</ToggleGroupItem>
              </ToggleGroup>
              {view === "markdown" ? <Raw value={result.markdown} /> : <div className="rounded-lg border p-3"><ScrapeMarkdown text={result.markdown} /></div>}
            </Section>
          )) : null}
        </>
      )}
    </Window>
  );
}
