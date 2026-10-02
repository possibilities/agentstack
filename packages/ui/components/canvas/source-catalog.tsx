"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarkedIcon, ChevronDownIcon, ChevronRightIcon, FileCodeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { addSchemaChunk, hookTypes, searchCatalog } from "@/lib/stack/source";
import type { GithubCatalog, GithubCatalogEntry, GithubCatalogVariant, GithubHookType, GithubSchemaChunk } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Empty } from "./primitives";
import { useStack, useStore } from "./provider";
import { sourceChip, sourceHint, sourceLabel, sourceUnavailable } from "./source-shared";
import { fieldLabel, Raw } from "./scrape-shared";
import { Window } from "./window";

const variantNames: Record<GithubCatalogVariant, string> = { "api.github.com": "GitHub Cloud", ghec: "Enterprise Cloud", "ghes-3.14": "Enterprise Server 3.14", "ghes-3.15": "Enterprise Server 3.15",
  "ghes-3.16": "Enterprise Server 3.16", "ghes-3.17": "Enterprise Server 3.17", "ghes-3.18": "Enterprise Server 3.18", "ghes-3.19": "Enterprise Server 3.19" };
const schemaChars = 32_000;
const renderChars = 200_000;

/**
 * The pinned official event catalog: documentation, not an intake allowlist. An event this catalog does not list
 * is still accepted and can still be filtered on. Schemas load on demand, one chunk at a time, from one version.
 */
export function CatalogWindow() {
  const store = useStore();
  const { status, endpoints } = useStack();
  const [variant, setVariant] = useState<GithubCatalogVariant>("api.github.com");
  const [hookType, setHookType] = useState<GithubHookType | "">("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ key: string; data: GithubCatalog | null; error: string | null }>({ key: "", data: null, error: null });
  const [expanded, setExpanded] = useState<string | null>(null);
  const token = useRef(0);
  const key = `${variant}|${hookType}`;
  const open = status.source === "open";
  useEffect(() => {
    if (!open) return;
    const mine = ++token.current;
    store.call<GithubCatalog>("source", "github_event_catalog", { variant, ...(hookType ? { hookType } : {}) }).then(
      (data) => { if (mine === token.current) setState({ key, data, error: null }); },
      (error: unknown) => { if (mine === token.current) setState((held) => ({ key, data: held.key === key ? held.data : null, error: error instanceof Error ? error.message : String(error) })); });
    return () => { token.current++; };
  }, [store, variant, hookType, key, open]);
  const catalog = state.key === key ? state.data : null;
  const shown = useMemo(() => (catalog ? searchCatalog(catalog.entries, query) : []), [catalog, query]);
  const unavailable = sourceUnavailable(endpoints, status);
  return (
    <Window id="source-catalog" title="Event catalog" icon={BookMarkedIcon} accent="source" count={catalog?.entries.length ?? null}
      status={endpoints.source ? status.source : undefined} endpoint={endpoints.source} error={state.key === key ? state.error : null} empty={!endpoints.source}>
      {!endpoints.source ? <Empty icon={BookMarkedIcon} title="Source isn't served by this server" /> : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className={fieldLabel}>Variant</span>
              <NativeSelect size="sm" className="w-full" value={variant} onChange={(event) => { setVariant(event.target.value as GithubCatalogVariant); setExpanded(null); }}>
                {(catalog?.variants ?? Object.keys(variantNames) as GithubCatalogVariant[]).map((item) => <NativeSelectOption key={item} value={item}>{variantNames[item] ?? item}</NativeSelectOption>)}
              </NativeSelect>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={fieldLabel}>Hook type</span>
              <NativeSelect size="sm" className="w-full" value={hookType} onChange={(event) => { setHookType(event.target.value as GithubHookType | ""); setExpanded(null); }}>
                <NativeSelectOption value="">Any hook type</NativeSelectOption>
                {hookTypes.map((item) => <NativeSelectOption key={item} value={item}>{item.replace("_", " ")}</NativeSelectOption>)}
              </NativeSelect>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Search events and actions</span>
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="issues, opened, review…" autoComplete="off" spellCheck={false} className="h-7 text-[0.78rem]" />
          </label>
          {catalog ? (
            <p className={cn(sourceHint, "flex flex-wrap gap-x-2")}>
              <span className="tabular-nums">{shown.length} of {catalog.entries.length} events</span>
              <span>· {catalog.source} <span className="font-mono">{catalog.version}</span></span>
            </p>
          ) : null}
          <p className={sourceHint}>Documentation only. Events missing here are still accepted, and any event name can be used in a delivery filter.</p>
          {!catalog ? <Empty icon={BookMarkedIcon} title={state.key === key && state.error ? "Catalog unavailable" : unavailable ?? "Reading catalog…"} hint={state.key === key ? state.error ?? undefined : undefined} />
            : !shown.length ? <Empty icon={BookMarkedIcon} title="No event matches" hint="An unlisted name is not an error: it can still arrive and be filtered on." /> : (
              <ul className="flex flex-col gap-0.5">
                {shown.map((entry) => <EventRow key={entry.event} entry={entry} catalog={catalog} expanded={expanded === entry.event} onToggle={() => setExpanded(expanded === entry.event ? null : entry.event)} />)}
              </ul>
            )}
        </>
      )}
    </Window>
  );
}

function EventRow({ entry, catalog, expanded, onToggle }: { entry: GithubCatalogEntry; catalog: GithubCatalog; expanded: boolean; onToggle(): void }) {
  const detail = `catalog-${entry.event}`;
  return (
    <li className="rounded-lg px-2 py-1.5 hover:bg-muted/60">
      <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={detail} className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-[0.76rem] focus-visible:outline-2 focus-visible:outline-ring">
        {expanded ? <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate font-mono font-medium">{entry.event}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[0.66rem] text-muted-foreground">
          {entry.cloudOnly ? <span className={sourceChip}>cloud only</span> : null}
          <span className="tabular-nums">{entry.actions.length} {entry.actions.length === 1 ? "action" : "actions"}</span>
        </span>
      </button>
      {expanded ? (
        <div id={detail} className="mt-1.5 flex flex-col gap-2 pl-5">
          <p className="text-[0.72rem] text-pretty text-muted-foreground">{entry.summary}</p>
          <p className="flex flex-wrap items-center gap-1 text-[0.66rem]">
            <span className={sourceLabel}>Hooks</span>
            {entry.supportedWebhookTypes.map((type) => <span key={type} className={sourceChip}>{type.replace("_", " ")}</span>)}
            {entry.customActions ? <span className={sourceChip}>custom actions</span> : null}
          </p>
          {entry.actions.length ? (
            <ul className="flex flex-col gap-1">
              {entry.actions.map((action) => (
                <li key={`${action.action ?? ""}|${action.schemaRef}`} className="flex flex-col text-[0.7rem]">
                  <span className="font-mono">{action.action ?? "(no action)"}</span>
                  <span className="text-pretty text-muted-foreground">{action.description}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <SchemaReader catalog={catalog} entry={entry} />
        </div>
      ) : null}
    </li>
  );
}

type Held = { variant: string; version: string; total: number; text: string; nextOffset: number | null };

/** The schema bundle for one event, read a chunk at a time from a single variant and version. It explains payloads; it validates nothing. */
function SchemaReader({ catalog, entry }: { catalog: GithubCatalog; entry: GithubCatalogEntry }) {
  const store = useStore();
  const [action, setAction] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const request = useRef(0);
  const reset = () => { request.current++; setHeld(null); setBusy(false); setError(null); setNote(null); };
  useEffect(reset, [catalog.variant, catalog.version, entry.event]);
  const read = async (offset: number, current: Held | null) => {
    const mine = ++request.current;
    setBusy(true); setError(null); setNote(null);
    try {
      const chunk = await store.call<GithubSchemaChunk>("source", "github_event_schema", { variant: catalog.variant, event: entry.event, ...(action ? { action } : {}), offset, limit: schemaChars });
      if (mine !== request.current) return;
      const next = addSchemaChunk(current, chunk, offset);
      if (next.restarted) setNote("The schema bundle changed while it was being read, so reading started over.");
      setHeld(next);
    } catch (failure) {
      if (mine === request.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mine === request.current) setBusy(false);
    }
  };
  const actions = entry.actions.filter((item) => item.action);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {actions.length ? (
          <NativeSelect size="sm" aria-label={`Schema action for ${entry.event}`} value={action} onChange={(event) => { setAction(event.target.value); reset(); }}>
            <NativeSelectOption value="">Whole event</NativeSelectOption>
            {actions.map((item) => <NativeSelectOption key={item.action!} value={item.action!}>{item.action}</NativeSelectOption>)}
          </NativeSelect>
        ) : null}
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void read(0, null)}>
          <FileCodeIcon data-icon="inline-start" />{held ? "Read again" : "Inspect schema"}
        </Button>
        {busy ? <Spinner /> : null}
      </div>
      {error ? <p role="alert" className="text-[0.7rem] text-destructive">{error}</p> : null}
      {note ? <p role="status" className="text-[0.7rem] text-warning">{note}</p> : null}
      {held ? (
        <>
          <p className="flex flex-wrap gap-x-2 text-[0.68rem] text-muted-foreground tabular-nums">
            <span>{held.text.length.toLocaleString("en-US")} of {held.total.toLocaleString("en-US")} characters</span>
            <span className="font-mono">{held.variant} · {held.version}</span>
          </p>
          <Raw value={held.text.length > renderChars ? held.text.slice(0, renderChars) : held.text} className="max-h-72" />
          {held.text.length > renderChars ? <p className={sourceHint}>Showing the first {renderChars.toLocaleString("en-US")} characters; the rest is loaded but not drawn.</p> : null}
          {held.nextOffset !== null ? <div><Button size="xs" variant="outline" disabled={busy} onClick={() => void read(held.nextOffset!, held)}>Load next chunk</Button></div> : <p className={sourceHint}>Whole bundle loaded.</p>}
        </>
      ) : null}
      <p className={sourceHint}>Explains a payload&rsquo;s shape from the official schema; it is not used to reject anything that arrives.</p>
    </div>
  );
}
