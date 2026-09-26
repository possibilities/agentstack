"use client";

import { useEffect, useState } from "react";
import { ListTreeIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { catalogIdentity, catalogRows, effortLevels, modelName, shortId, workerAccountLabels } from "@/lib/stack/derive";
import type { StackState } from "@/lib/stack/store";
import { nodeKey, type WorkerAccount, type WorkerCatalog } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty, NodeTitle, Orb, Time } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";
import { Window } from "./window";

/** Refreshes every listed account's catalog; a stacked tab refreshes all of its accounts. */
export function CatalogRefresh({ ids, iconOnly = false }: { ids: string[]; iconOnly?: boolean }) {
  const { catalogPending, status, workerAccounts } = useStack();
  const store = useStore();
  const pending = ids.some((id) => catalogPending[id]);
  const disabled = pending || status.workers !== "open" || ids.some((id) => {
    const account = workerAccounts.data?.find((item) => item.id === id);
    return !account?.ready || !account.enabled || account.removing;
  });
  const refresh = () => ids.forEach((id) => void store.refreshWorkerCatalog(id));
  const icon = pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />;
  if (!iconOnly) return <Button size="xs" variant="outline" disabled={disabled} onClick={refresh}>{icon}Refresh</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Refresh catalog" disabled={disabled} onClick={refresh} />}>
        {pending ? <Spinner /> : <RefreshCwIcon />}
      </TooltipTrigger>
      <TooltipContent side="bottom">Refresh</TooltipContent>
    </Tooltip>
  );
}

function catalogState({ workerAccounts, workerCatalogs, workerRuntimes, status }: StackState, id: string, now: number) {
  const resource = workerCatalogs[id];
  const catalog = resource?.data;
  const account = workerAccounts.data?.find((item) => item.id === id);
  const runtime = workerRuntimes.data?.find((item) => item.id === id);
  const stale = !catalog || catalog.stale || Boolean(catalog.error || resource?.error || workerRuntimes.error) || !account?.ready || !account.enabled || account.removing
    || status.workers !== "open" || runtime?.state !== "running" || now - Date.parse(catalog.observedAt) >= 30 * 60_000;
  const unavailable = !account ? null : account.removing ? "Removing" : !account.ready ? "Sign in to see models" : !account.enabled ? "Enable to see models" : null;
  return { catalog, stale, error: resource?.error ?? catalog?.error ?? runtime?.error ?? null, unavailable };
}

function useCatalogState(id: string) {
  return catalogState(useStack(), id, useNow(30_000));
}

export function CatalogStatus({ id }: { id: string }) {
  const { catalog, stale, error } = useCatalogState(id);
  return <>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Badge variant={stale ? "outline" : "secondary"}>{catalog ? stale ? "Stale" : "Observed" : "Not observed"}</Badge>
      {catalog && Date.parse(catalog.observedAt) > 0 ? <Time at={Date.parse(catalog.observedAt)} /> : null}
    </div>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </>;
}

/** Seven rising bars, one per effort level; lit bars are the levels a model accepts. */
function EffortLadder({ efforts }: { efforts: string[] }) {
  const supported = new Set(efforts);
  return (
    <span aria-hidden className="flex h-2.5 items-end gap-[2px]">
      {effortLevels.map((level, index) => (
        <span key={level} className={cn("w-[3px] rounded-[1px]", supported.has(level) ? "bg-pkg-bots" : "bg-muted-foreground/15")} style={{ height: `${40 + index * 10}%` }} />
      ))}
    </span>
  );
}

const matches = (needle: string, ...values: string[]) => !needle || values.some((value) => value.toLowerCase().includes(needle));

function ModelList({ catalog, needle }: { catalog: WorkerCatalog; needle: string }) {
  const models = catalog.models.filter((model) => matches(needle, model.id, model.name, ...model.efforts));
  const native = catalog.nativeModelIds.filter((id) => matches(needle, id));
  if (!models.length && !native.length) return <Empty icon={SearchIcon} title="No matches" />;
  return (
    <>
      <ul className="-mx-1 flex flex-col">
        {models.map((model) => {
          const levels = model.efforts.filter((effort) => effort !== "default");
          return (
            <li key={model.id} className="group/row flex min-h-7 items-center gap-2 rounded-md px-1.5 text-[0.8rem] hover:bg-muted/70">
              <span className="min-w-0 truncate" title={model.id}>{modelName(model.name)}</span>
              <CopyButton value={model.id} label={`${modelName(model.name)} ID`} className="size-5" />
              {levels.length ? (
                <Tooltip>
                  <TooltipTrigger render={<span tabIndex={0} aria-label={`Efforts: ${levels.join(", ")}`} className="ml-auto flex h-5 items-center rounded-sm px-1 focus-visible:outline-2 focus-visible:outline-ring" />}>
                    <EffortLadder efforts={levels} />
                  </TooltipTrigger>
                  <TooltipContent side="left">{levels.join(" · ")}</TooltipContent>
                </Tooltip>
              ) : <span className="ml-auto px-1 text-[0.68rem] text-muted-foreground/60">—</span>}
            </li>
          );
        })}
      </ul>
      {native.length ? (
        <details className="group/native rounded-lg bg-muted/50 px-2.5 py-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground marker:text-muted-foreground/50">{native.length} native ID{native.length === 1 ? "" : "s"}</summary>
          <ul className="mt-2 flex flex-col gap-0.5">{native.map((id) => <li key={id} className="font-mono text-[0.7rem] break-all">{id}</li>)}</ul>
        </details>
      ) : null}
    </>
  );
}

/** One tab's catalog; a stack's accounts share an identity, so the first account's state speaks for all. */
function CatalogPanel({ accounts, labels, needle }: { accounts: WorkerAccount[]; labels: Map<string, string>; needle: string }) {
  const { catalogPending } = useStack();
  const [account] = accounts;
  const { catalog, stale, error, unavailable } = useCatalogState(account.id);
  const nodeOf = (id: string) => ({ kind: "worker-catalog" as const, id });
  const label = (id: string) => labels.get(id) ?? shortId(id);
  return (
    <div data-node={nodeKey(nodeOf(account.id))} className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1.5 px-0.5 text-[0.7rem] text-muted-foreground">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          {accounts.map((item, index) => (
            <span key={item.id} data-node={index ? nodeKey(nodeOf(item.id)) : undefined} className={cn("min-w-0 break-all", !index && "font-medium text-foreground")}>
              <NodeTitle node={nodeOf(item.id)} label={`${label(item.id)} model catalog`}>{label(item.id)}</NodeTitle>
            </span>
          ))}
        </span>
        {catalog ? (
          <>
            <span aria-hidden>·</span>
            <span className={cn(stale && "text-warning")}>{stale ? "stale" : "observed"} <Time at={Date.parse(catalog.observedAt)} /></span>
            <span aria-hidden>·</span>
            <span className="truncate" title={`${catalog.source} · ${catalog.runtimeVersion}`}>{catalog.runtimeVersion.split(" ").slice(0, 2).join(" ")}</span>
          </>
        ) : null}
        <span className="ml-auto"><CatalogRefresh ids={accounts.map((item) => item.id)} iconOnly /></span>
      </div>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {unavailable ? <Empty icon={ListTreeIcon} title={unavailable} />
        : catalog ? <ModelList catalog={catalog} needle={needle} />
        : accounts.some((item) => catalogPending[item.id]) ? <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"><Spinner />Reading catalog…</p>
        : <Empty icon={ListTreeIcon} title="Not observed" />}
    </div>
  );
}

export function CatalogWindow() {
  const stack = useStack();
  const { workerAccounts, workerRuntimes, workerCatalogs, status, endpoints } = stack;
  const { selected, flash } = useWorkbench();
  const now = useNow(30_000);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const accounts = workerAccounts.data ?? [];
  const labels = workerAccountLabels(workerAccounts.data);
  const needle = query.trim().toLowerCase();
  // Accounts whose catalogs are identical share one stacked tab.
  const rows = catalogRows(accounts, (account) => {
    const state = catalogState(stack, account.id, now);
    return state.catalog ? catalogIdentity({ ...state, catalog: state.catalog }) : null;
  });
  const active = rows.find((row) => row.some((account) => account.id === chosen)) ?? rows.find((row) => workerCatalogs[row[0].id]?.data) ?? rows[0];

  // Inspecting or jumping to a catalog brings its tab forward.
  const focus = selected?.kind === "worker-catalog" ? selected.id : flash?.key.startsWith("worker-catalog:") ? flash.key.slice("worker-catalog:".length) : null;
  useEffect(() => {
    if (focus) setChosen(focus);
  }, [focus]);

  const countFor = (id: string) => {
    const catalog = workerCatalogs[id]?.data;
    if (!catalog) return null;
    return needle ? catalog.models.filter((model) => matches(needle, model.id, model.name, ...model.efforts)).length : catalog.models.length;
  };

  return (
    <Window id="model-catalogs" title="Models" subtitle="workers" icon={ListTreeIcon} accent="bots" status={status.workers} endpoint={endpoints.workers} error={workerAccounts.error ?? workerRuntimes.error}>
      {accounts.length && active ? (
        <>
          {/* Tabs and the filter stay pinned while the window body scrolls a long catalog. */}
          <div className="sticky -top-3.5 z-10 -mx-3.5 -mt-3.5 flex flex-col gap-2 border-b border-border/60 bg-card/95 px-3.5 py-3 backdrop-blur-xl">
          <div role="tablist" aria-label="Worker accounts" className="-mx-0.5 flex flex-wrap gap-1 px-0.5">
            {rows.map((row) => {
              const [account] = row;
              const count = countFor(account.id);
              const current = row === active;
              return (
                <button key={account.id} type="button" role="tab" aria-selected={current} data-node={nodeKey({ kind: "worker-catalog", id: account.id })}
                  onClick={() => setChosen(account.id)}
                  className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[0.75rem] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    current ? "border-foreground/15 bg-background text-foreground shadow-xs" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                    (!account.ready || !account.enabled) && "opacity-60")}>
                  <span className="flex shrink-0 -space-x-1">
                    {row.map((item) => <Orb key={item.id} id={item.id} size="sm" className={cn("size-2.5", row.length > 1 && "ring-[1.5px] ring-card")} />)}
                  </span>
                  {row.map((item, index) => (
                    <span key={item.id} data-node={index ? nodeKey({ kind: "worker-catalog", id: item.id }) : undefined} className={cn(index && "font-normal text-muted-foreground")}>
                      {labels.get(item.id) ?? shortId(item.id)}
                    </span>
                  ))}
                  {count !== null ? <span className={cn("tabular-nums", current ? "text-muted-foreground" : "text-muted-foreground/70")}>{count}</span> : null}
                </button>
              );
            })}
          </div>
          <InputGroup className="h-8">
            <InputGroupAddon><SearchIcon /></InputGroupAddon>
            <InputGroupInput aria-label="Filter models" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter models" />
          </InputGroup>
          </div>
          <CatalogPanel key={active.map((account) => account.id).join(" ")} accounts={active} labels={labels} needle={needle} />
        </>
      ) : (
        <Empty icon={ListTreeIcon} title={workerAccounts.data ? "No Worker accounts" : "Accounts unavailable"}>{workerAccounts.data ? "Add one to see its models." : workerAccounts.error ?? "Waiting for auth."}</Empty>
      )}
    </Window>
  );
}
