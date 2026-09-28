"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpenTextIcon, ExternalLinkIcon, LibraryBigIcon, RefreshCwIcon, SearchIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { brainCallError, brainLocalReason, chunkRange, contextText, externalHref, filterArgs, formatBytes, sourceHost, type CallError } from "@/lib/stack/brain";
import type { BrainChunk, BrainContentKind, BrainContext, BrainDocument, BrainFilters, BrainHit, BrainLink, BrainSearch, BrainSensitivity } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty, NodeCard, NodeTitle, Row, Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { badge, brainUnavailable, SensitivityBadge, Snippet, TagList } from "./brain-shared";
import { CallErrorNote, fieldLabel } from "./scrape-shared";
import { Section, Window } from "./window";

type Mode = BrainSearch["mode"];
type Tab = "results" | "context";
type Ran = { query: string; mode: Mode; filters: BrainFilters; generation: number };

const pageSize = 20;
const contextChars = 12_000;
/** Rendering cost grows with length; Load full still fetches everything and copy keeps it. */
const renderLimit = 200_000;

/**
 * Ranked chunk search over Brain's index, and the same query as citation-ready context. With no
 * query it shows the index: counts, source types, top tags and recent documents.
 */
export function SearchWindow() {
  const store = useStore();
  const { status, endpoints, brainStats, brainTags, brainIndexGeneration, brainQuery } = useStack();
  const formId = useId();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("any");
  const [filters, setFilters] = useState<BrainFilters>({});
  const [more, setMore] = useState(false);
  const [tab, setTab] = useState<Tab>("results");
  const [ran, setRan] = useState<Ran | null>(null);
  const [results, setResults] = useState<{ hits: BrainHit[]; next: number | null } | null>(null);
  const [context, setContext] = useState<BrainContext | null>(null);
  const [busy, setBusy] = useState<"results" | "context" | "more" | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const offline = brainUnavailable(endpoints, status);
  const stats = brainStats.data;
  const setFilter = (key: keyof BrainFilters, value: string) => setFilters((current) => ({ ...current, [key]: value || undefined }));
  const activeFilters = Object.keys(filterArgs(filters)).length;

  const run = async (next: { query: string; mode: Mode; filters: BrainFilters }, which: Tab, offset = 0) => {
    const text = next.query.trim();
    if (!text || offline) return;
    setBusy(offset ? "more" : which);
    setError(null);
    const args = { query: text, ...filterArgs(next.filters) };
    try {
      if (which === "results") {
        const page = await store.call<BrainSearch>("brain", "search", { ...args, mode: next.mode, limit: pageSize, offset });
        store.rememberBrainDocuments(page.results);
        setResults((current) => ({ hits: offset && current ? [...current.hits, ...page.results] : page.results, next: page.next_offset }));
        if (!offset) setContext(null);
      } else {
        const result = await store.call<BrainContext>("brain", "context", { ...args, limit: 8, "max-chars": contextChars });
        store.rememberBrainDocuments(result.hits);
        setContext(result);
        if (!offset) setResults(null);
      }
      if (!offset) setRan({ query: text, mode: next.mode, filters: next.filters, generation: brainIndexGeneration });
    } catch (failure) {
      setError(brainCallError(failure));
    } finally {
      setBusy(null);
    }
  };
  const submit = (which = tab) => void run({ query, mode, filters }, which);
  const pick = (key: keyof BrainFilters, value: string) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    if (query.trim()) void run({ query, mode, filters: next }, tab);
  };

  // Another surface (the palette) asked for a query.
  const handled = useRef(0);
  useEffect(() => {
    if (!brainQuery || brainQuery.seq === handled.current) return;
    handled.current = brainQuery.seq;
    setQuery(brainQuery.query);
    setTab("results");
    void run({ query: brainQuery.query, mode, filters }, "results");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brainQuery]);

  const switchTab = (next: Tab) => {
    setTab(next);
    if (ran && (next === "results" ? !results : !context)) void run(ran, next);
  };
  const stale = ran !== null && ran.generation !== brainIndexGeneration;
  const tagOptions = brainTags.data ?? stats?.top_tags ?? [];

  return (
    <Window id="brain-search" title="Search" icon={SearchIcon} accent="brain" status={endpoints.brain ? status.brain : undefined} endpoint={endpoints.brain}
      updatedAt={brainStats.at} error={brainStats.error} empty={!endpoints.brain}>
      {!endpoints.brain ? <Empty icon={SearchIcon} title="Brain isn't served by this owner" /> : (
        <>
          <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <div className="flex items-center gap-2">
              <label htmlFor={`${formId}-query`} className="sr-only">Search collected research</label>
              <Input id={`${formId}-query`} type="search" value={query} placeholder="Search collected research…" autoComplete="off" spellCheck={false}
                onChange={(event) => setQuery(event.target.value)} className="h-8 min-w-0 flex-1 text-[0.8rem]" />
              <Button type="submit" size="sm" disabled={Boolean(offline) || !query.trim() || busy !== null} title={offline ?? undefined}>
                {busy === "results" || busy === "context" ? <Spinner data-icon="inline-start" /> : <SearchIcon data-icon="inline-start" />}Search
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterSelect label="Match" value={mode} onChange={(value) => setMode(value as Mode)} options={[["any", "Any word"], ["all", "Every word"], ["raw", "FTS5 syntax"]]} />
              <FilterSelect label="Tag" value={filters.tag ?? ""} onChange={(value) => pick("tag", value)}
                options={[["", "Any tag"], ...tagOptions.map((tag): [string, string] => [tag.tag, `#${tag.tag} (${tag.count})`])]} />
              <FilterSelect label="Source type" value={filters["source-type"] ?? ""} onChange={(value) => pick("source-type", value)}
                options={[["", "Any type"], ...(stats?.by_source_type ?? []).map((item): [string, string] => [item.source_type, `${item.source_type} (${item.count})`])]} />
              <FilterSelect label="Content kind" value={filters["content-kind"] ?? ""} onChange={(value) => pick("content-kind", value as BrainContentKind)}
                options={[["", "Any kind"], ["article", "Article"], ["post", "Post"], ["thread", "Thread"]]} />
              <Button type="button" size="xs" variant={more ? "secondary" : "ghost"} aria-expanded={more} onClick={() => setMore(!more)}>
                <SlidersHorizontalIcon data-icon="inline-start" />More{activeFilters ? ` · ${activeFilters}` : ""}
              </Button>
            </div>
            {more ? (
              <div className="grid grid-cols-2 gap-2 rounded-lg border p-2">
                <label className="flex flex-col gap-1">
                  <span className={fieldLabel}>Sensitivity</span>
                  <NativeSelect size="sm" value={filters.sensitivity ?? ""} onChange={(event) => setFilter("sensitivity", event.target.value as BrainSensitivity)}>
                    <NativeSelectOption value="">Any</NativeSelectOption>
                    {(["public", "normal", "sensitive", "private"] as const).map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
                  </NativeSelect>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={fieldLabel}>Collection slug</span>
                  <Input value={filters.collection ?? ""} onChange={(event) => setFilter("collection", event.target.value)} spellCheck={false} autoComplete="off" className="h-7 font-mono text-[0.74rem]" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={fieldLabel}>Updated from</span>
                  <Input type="date" value={filters["date-from"] ?? ""} onChange={(event) => setFilter("date-from", event.target.value)} className="h-7 text-[0.74rem]" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={fieldLabel}>Updated through</span>
                  <Input type="date" value={filters["date-to"] ?? ""} onChange={(event) => setFilter("date-to", event.target.value)} className="h-7 text-[0.74rem]" />
                </label>
                {activeFilters ? <Button type="button" size="xs" variant="ghost" className="col-span-2 justify-self-start" onClick={() => setFilters({})}>Clear filters</Button> : null}
              </div>
            ) : null}
          </form>
          {ran || results || context ? (
            <div className="flex items-center gap-2">
              <ToggleGroup value={[tab]} onValueChange={(next: string[]) => { if (next.length) switchTab(next[0] as Tab); }} spacing={0} size="sm" variant="outline" aria-label="Show">
                <ToggleGroupItem value="results">Results</ToggleGroupItem>
                <ToggleGroupItem value="context">Context</ToggleGroupItem>
              </ToggleGroup>
              {stale ? (
                <Button type="button" size="xs" variant="ghost" className="ml-auto text-warning" onClick={() => ran && void run(ran, tab)} title="Documents were added, replaced or deleted since this search">
                  <RefreshCwIcon data-icon="inline-start" />Index changed · run again
                </Button>
              ) : null}
            </div>
          ) : null}
          <CallErrorNote error={error} />
          {!ran ? <IndexOverview onTag={(tag) => { setFilters((current) => ({ ...current, tag })); }} onType={(type) => setFilters((current) => ({ ...current, "source-type": type }))} />
            : tab === "results" ? (
              results ? (
                results.hits.length ? (
                  <ol className="flex flex-col gap-0.5" aria-label={`Results for ${ran.query}`}>
                    {results.hits.map((hit) => <HitRow key={`${hit.chunk_id}`} hit={hit} onTag={(tag) => pick("tag", tag)} />)}
                    {results.next !== null ? (
                      <li className="pt-1">
                        <Button type="button" size="xs" variant="ghost" className="w-full" disabled={busy !== null} onClick={() => void run(ran, "results", results.next!)}>
                          {busy === "more" ? <Spinner data-icon="inline-start" /> : null}More results
                        </Button>
                      </li>
                    ) : null}
                  </ol>
                ) : <NoMatch mode={ran.mode} filters={ran.filters} />
              ) : busy ? <p className="px-0.5 text-[0.72rem] text-muted-foreground">Searching…</p> : null
            ) : context ? <ContextView context={context} /> : busy ? <p className="px-0.5 text-[0.72rem] text-muted-foreground">Gathering context…</p> : null}
        </>
      )}
    </Window>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange(value: string): void }) {
  return (
    <NativeSelect size="sm" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className={cn("max-w-40 text-[0.72rem]", value && "font-medium")}>
      {options.map(([option, text]) => <NativeSelectOption key={option} value={option}>{text}</NativeSelectOption>)}
    </NativeSelect>
  );
}

function NoMatch({ mode, filters }: { mode: Mode; filters: BrainFilters }) {
  const narrowed = Object.keys(filterArgs(filters)).length;
  return (
    <div className="flex flex-col gap-1">
      <Empty icon={SearchIcon} title="No matching chunks" />
      <p className="px-0.5 text-center text-[0.7rem] text-pretty text-muted-foreground">
        {narrowed ? "Filters narrow this search. " : ""}{mode === "any" ? "Try other words or a tag." : "Any word matches more than every word."} Submitted material is searchable only after its job completes.
      </p>
    </div>
  );
}

function HitRow({ hit, onTag }: { hit: BrainHit; onTag(tag: string): void }) {
  const store = useStore();
  const node = { kind: "research-document" as const, id: String(hit.document_id) };
  const title = hit.title || sourceHost(hit.source_uri);
  return (
    <li className="relative">
      <NodeCard node={node} label={title} variant="row">
        <div className="flex min-w-0 items-baseline gap-2">
          <button type="button" className="min-w-0 truncate text-left text-[0.8rem] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            title="Open in Reader" onClick={() => store.openBrainDocument(hit.document_id, hit)}>{title}</button>
          <SensitivityBadge value={hit.sensitivity} />
          <NodeTitle node={node} label={title} className="ml-auto shrink-0 font-mono text-[0.64rem] text-muted-foreground">#{hit.document_id}</NodeTitle>
        </div>
        <Snippet text={hit.snippet} />
        <div className="flex min-w-0 items-center gap-2 text-[0.64rem] text-muted-foreground">
          <span className="truncate" title={hit.source_uri}>{sourceHost(hit.source_uri)}</span>
          <span className="shrink-0">{hit.content_kind ?? hit.source_type}</span>
          <TagList tags={hit.tags} onPick={onTag} limit={3} />
          <span className="ml-auto shrink-0"><Time at={Date.parse(hit.updated_at)} /></span>
        </div>
      </NodeCard>
    </li>
  );
}

function ContextView({ context }: { context: BrainContext }) {
  const store = useStore();
  const text = useMemo(() => contextText(context.hits), [context]);
  if (!context.hits.length) return <Empty icon={BookOpenTextIcon} title="No context for this query" />;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 px-0.5 text-[0.7rem] text-muted-foreground">
        <span className="tabular-nums">{context.hits.length} hits · {context.returned_chars.toLocaleString()} of {context.max_chars.toLocaleString()} characters{context.truncated ? " · trimmed to budget" : ""}</span>
        <span className="ml-auto flex items-center gap-1">Copy all<CopyButton value={text} label="context" className="opacity-100" /></span>
      </p>
      <ol className="flex flex-col gap-3">
        {context.hits.map((hit) => (
          <li key={hit.chunk_id} className="flex flex-col gap-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <button type="button" className="min-w-0 truncate text-left text-[0.78rem] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => store.openBrainDocument(hit.document_id, hit)}>{hit.title || sourceHost(hit.source_uri)}</button>
              <SensitivityBadge value={hit.sensitivity} />
              <CopyButton value={`${hit.citation}\n\n${hit.content.trim()}`} label="this hit" className="ml-auto opacity-100" />
            </div>
            <p className="font-mono text-[0.64rem] break-all text-muted-foreground">{hit.citation}</p>
            <p className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 text-[0.72rem] whitespace-pre-wrap break-words text-foreground/90">{hit.content.trim()}{hit.truncated ? " …" : ""}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What the index holds, shown before any query: the inventory to consult when discovery is poor. */
function IndexOverview({ onTag, onType }: { onTag(tag: string): void; onType(type: string): void }) {
  const store = useStore();
  const { brainStats } = useStack();
  const stats = brainStats.data;
  if (!stats) return <Empty icon={LibraryBigIcon} title={brainStats.error ? "Index unavailable" : "Reading the index…"} />;
  if (!stats.document_count) return (
    <div className="flex flex-col gap-1">
      <Empty icon={LibraryBigIcon} title="Nothing indexed yet" />
      <p className="px-0.5 text-center text-[0.7rem] text-muted-foreground">Submit a URL or text in Ingest, or share from a paired device.</p>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2 px-0.5">
        {[["Documents", stats.document_count.toLocaleString()], ["Chunks", stats.chunk_count.toLocaleString()], ["Database", formatBytes(stats.db_size_bytes)]].map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-[0.66rem] text-muted-foreground">{label}</dt>
            <dd className="text-[0.95rem] font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {stats.failed_relation_count ? (
        <p className="px-0.5 text-[0.7rem] text-muted-foreground">{stats.relation_count.toLocaleString()} links between documents, {stats.failed_relation_count.toLocaleString()} unresolved</p>
      ) : null}
      <Section title="Recent">
        <ul className="flex flex-col gap-0.5">
          {stats.recent.map((doc) => (
            <li key={doc.document_id}>
              <button type="button" onClick={() => store.openBrainDocument(doc.document_id)}
                className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-[0.76rem] hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring">
                <span className="min-w-0 truncate">{doc.title || sourceHost(doc.source_uri)}</span>
                <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground"><Time at={Date.parse(doc.updated_at)} /></span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      {stats.top_tags.length ? (
        <Section title="Top tags" aside={<span className="text-[0.65rem] text-muted-foreground">Choose one to filter</span>}>
          <div className="flex flex-wrap gap-1">
            {stats.top_tags.map((tag) => (
              <button key={tag.tag} type="button" onClick={() => onTag(tag.tag)} className={cn(badge, "hover:bg-muted-foreground/15 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring")}>
                #{tag.tag} <span className="tabular-nums opacity-70">{tag.count}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      <Section title="Source types">
        <ul className="flex flex-col">
          {stats.by_source_type.map((item) => (
            <li key={item.source_type}>
              <button type="button" onClick={() => onType(item.source_type)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-[0.74rem] hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring">
                <span className="font-mono">{item.source_type}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{item.count.toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

type Loaded = { documentId: number; full: boolean; document: BrainDocument; chunk: BrainChunk | null };

/**
 * One Research document as Brain's index holds it now. Extracted content is untrusted, so it is
 * plain text: nothing renders as HTML, nothing loads, and only the source link opens, on request.
 */
export function ReaderWindow() {
  const store = useStore();
  const { status, endpoints, brainReader, brainIndexGeneration, remote } = useStack();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [full, setFull] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [missing, setMissing] = useState(false);
  const request = useRef(0);
  const documentId = brainReader?.documentId ?? null;
  const chunkId = brainReader?.chunk?.chunk_id ?? null;
  const open = status.brain === "open";

  useEffect(() => { setFull(false); }, [brainReader?.seq]);
  useEffect(() => {
    if (documentId === null || !open) return;
    const id = ++request.current;
    setLoading(true);
    setError(null);
    setMissing(false);
    void (async () => {
      try {
        const [document, chunk] = await Promise.all([
          store.call<BrainDocument>("brain", "get", full ? { "document-id": documentId, full: true } : { "document-id": documentId }),
          chunkId !== null ? store.call<BrainChunk>("brain", "get", { "chunk-id": chunkId }).catch(() => null) : Promise.resolve(null),
        ]);
        if (id !== request.current) return;
        store.rememberBrainDocuments([document]);
        setLoaded({ documentId, full, document, chunk });
      } catch (failure) {
        if (id !== request.current) return;
        const next = brainCallError(failure);
        if (/not_found/i.test(next.text)) { setMissing(true); setLoaded(null); } else setError(next);
      } finally {
        if (id === request.current) setLoading(false);
      }
    })();
  }, [documentId, chunkId, full, open, brainIndexGeneration, brainReader?.seq, store]);

  const doc = loaded?.documentId === documentId ? loaded.document : null;
  const node = documentId !== null ? { kind: "research-document" as const, id: String(documentId) } : undefined;
  return (
    <Window id="brain-reader" title="Reader" subtitle={doc?.title ?? undefined} icon={BookOpenTextIcon} accent="brain" node={node} reveal={node}
      status={endpoints.brain ? status.brain : undefined} endpoint={endpoints.brain} empty={!doc}
      actions={doc ? <DeleteDocument document={doc} blocked={brainLocalReason(remote) ?? brainUnavailable(endpoints, status)} /> : null}>
      {documentId === null ? <Empty icon={BookOpenTextIcon} title="Open a document from Search" />
        : missing ? <Empty icon={BookOpenTextIcon} title={`Document ${documentId} is no longer indexed`} />
        : !doc ? (error ? <CallErrorNote error={error} /> : <Empty icon={BookOpenTextIcon} title={loading ? "Reading…" : "Waiting for Brain"} />)
        : <DocumentView document={doc} chunk={loaded?.chunk ?? null} hit={brainReader?.chunk ?? null} full={loaded?.full ?? false} loading={loading} error={error} onFull={() => setFull(true)} />}
    </Window>
  );
}

function DocumentView({ document, chunk, hit, full, loading, error, onFull }: {
  document: BrainDocument; chunk: BrainChunk | null; hit: { start_char: number; end_char: number } | null; full: boolean; loading: boolean; error: CallError | null; onFull(): void;
}) {
  const store = useStore();
  const href = externalHref(document.source_uri);
  const truncated = document.truncation.omitted_chars > 0;
  const range = hit ? chunkRange(document.content, truncated, { ...hit, content: chunk?.content }) : null;
  const body = document.content.length > renderLimit ? document.content.slice(0, renderLimit) : document.content;
  const mark = useRef<HTMLElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Scroll only the text box to the passage; scrollIntoView would also move the canvas.
  useLayoutEffect(() => {
    if (mark.current && box.current) box.current.scrollTop = Math.max(0, mark.current.offsetTop - box.current.clientHeight / 3);
  }, [document.document_id, range?.[0]]);
  const links = [...document.outbound_links.map((link) => ({ link, direction: "out" as const })), ...document.inbound_links.map((link) => ({ link, direction: "in" as const }))];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-[0.95rem] leading-snug font-semibold text-balance">{document.title || sourceHost(document.source_uri)}</h3>
        <p className="flex min-w-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer noopener" className="flex min-w-0 items-center gap-1 hover:text-foreground hover:underline" title={document.source_uri}>
              <span className="truncate">{sourceHost(document.source_uri)}</span><ExternalLinkIcon className="size-3 shrink-0" />
            </a>
          ) : <span className="truncate font-mono" title={document.source_uri}>{document.source_uri}</span>}
          <CopyButton value={document.source_uri} label="source" className="opacity-100" />
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-[0.66rem] text-muted-foreground">
          <span className={badge}>{document.content_kind ?? document.source_type}</span>
          <TagList tags={document.tags} limit={12} />
        </div>
      </div>
      <dl className="flex flex-col">
        <Row label="Size" className="text-[0.74rem]"><span className="tabular-nums">{document.size_chars.toLocaleString()} characters</span></Row>
        <Row label="Updated" className="text-[0.74rem]"><Time at={Date.parse(document.updated_at)} /></Row>
        <Row label="Content hash" mono copy={document.content_hash} className="text-[0.74rem]"><span title={document.content_hash}>{document.content_hash.slice(0, 16)}…</span></Row>
      </dl>
      {document.notes ? <p className="rounded-md bg-muted/50 p-2 text-[0.74rem] whitespace-pre-wrap text-pretty">{document.notes}</p> : null}
      <CallErrorNote error={error} />
      {truncated && !full ? (
        <p className="flex items-center gap-2 px-0.5 text-[0.7rem] text-muted-foreground">
          <span className="tabular-nums">Showing the start and end: {document.truncation.omitted_chars.toLocaleString()} characters omitted{hit && !range ? ", including the matching passage" : ""}.</span>
          <Button type="button" size="xs" variant="outline" className="ml-auto shrink-0" disabled={loading} onClick={onFull}>{loading ? <Spinner data-icon="inline-start" /> : null}Load full</Button>
        </p>
      ) : null}
      <div ref={box} className="relative max-h-[28rem] overflow-auto rounded-lg border bg-background/60 p-3 text-[0.78rem] leading-relaxed whitespace-pre-wrap break-words text-foreground/90" tabIndex={0} aria-label="Document text">
        {range && range[1] <= body.length ? (
          <>
            {body.slice(0, range[0])}
            <mark ref={mark} className="rounded-sm bg-pkg-brain/20 text-foreground">{body.slice(range[0], range[1])}</mark>
            {body.slice(range[1])}
          </>
        ) : body}
      </div>
      {document.content.length > renderLimit ? <p className="px-0.5 text-[0.7rem] text-muted-foreground">Showing the first {renderLimit.toLocaleString()} of {document.content.length.toLocaleString()} characters.</p> : null}
      {links.length ? (
        <Section title="Links" aside={<span className="text-[0.65rem] text-muted-foreground">{document.outbound_links.length} out · {document.inbound_links.length} in</span>}>
          <ul className="flex flex-col gap-0.5">
            {links.map(({ link, direction }) => <LinkRow key={`${direction}:${link.id}`} link={link} direction={direction} onOpen={(id) => store.openBrainDocument(id)} self={document.document_id} />)}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function LinkRow({ link, direction, self, onOpen }: { link: BrainLink; direction: "in" | "out"; self: number; onOpen(id: number): void }) {
  const other = direction === "out" ? link.to_document_id : link.from_document_id;
  const url = link.resolved_url ?? link.discovered_url;
  const href = externalHref(url);
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[0.72rem] hover:bg-muted/70">
      <span className="shrink-0 text-muted-foreground" aria-label={direction === "out" ? "Links to" : "Linked from"}>{direction === "out" ? "→" : "←"}</span>
      {other !== null && other !== self ? (
        <button type="button" className="min-w-0 truncate text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onOpen(other)} title="Open in Reader">
          {url ? sourceHost(url) : `Document ${other}`}
        </button>
      ) : href ? <a href={href} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate hover:underline" title={url ?? undefined}>{sourceHost(url!)}</a>
        : <span className="min-w-0 truncate font-mono text-muted-foreground">{url ?? link.relation_type}</span>}
      <span className={cn("ml-auto shrink-0 text-[0.64rem]", link.status === "failed" ? "text-destructive" : "text-muted-foreground")} title={link.error ?? undefined}>{link.relation_type} · {link.status}</span>
    </li>
  );
}

/** Deletion purges the document, its chunks and everything its ingestion created; job history remains, redacted. */
function DeleteDocument({ document, blocked }: { document: BrainDocument; blocked: string | null }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const title = document.title || sourceHost(document.source_uri);
  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await store.brainDelete(document.document_id);
      setOpen(false);
    } catch (failure) {
      setError(brainCallError(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); setError(null); } }}>
      <AlertDialogTrigger render={<Button type="button" size="icon-sm" variant="ghost" />} disabled={Boolean(blocked)} aria-label={`Delete ${title}`} title={blocked ?? "Delete from Brain…"}>
        <Trash2Icon />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this document from Brain?</AlertDialogTitle>
          <AlertDialogDescription>
            {title}. Its text, chunks, links, collection memberships and provenance are purged, and captured bytes no other document uses are removed.
            Job history stays, with its content redacted. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <code className="text-xs break-all">{document.source_uri}</code>
        <CallErrorNote error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => void remove()}>{pending ? "Deleting…" : "Delete document"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
