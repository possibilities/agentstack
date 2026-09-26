"use client";

import { useId, useState } from "react";
import { ListTreeIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { Empty, NodeCard, NodeTitle, Time } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { Window } from "./window";

export function CatalogRefresh({ id }: { id: string }) {
  const { catalogPending, status, workerAccounts } = useStack();
  const store = useStore();
  const account = workerAccounts.data?.find((item) => item.id === id);
  return <Button size="xs" variant="outline" disabled={catalogPending[id] || status.workers !== "open" || !account?.ready || !account.enabled || account.removing} onClick={() => void store.refreshWorkerCatalog(id)}>
    {catalogPending[id] ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Refresh catalog
  </Button>;
}

export function CatalogStatus({ id }: { id: string }) {
  const { workerCatalogs, workerRuntimes, status } = useStack();
  const now = useNow(30_000);
  const resource = workerCatalogs[id];
  const catalog = resource?.data;
  const runtime = workerRuntimes.data?.find((item) => item.id === id);
  const stale = !catalog || catalog.stale || Boolean(resource?.error) || status.workers !== "open" || runtime?.state !== "running" || now - Date.parse(catalog.observedAt) >= 30 * 60_000;
  return <>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge variant={stale ? "outline" : "secondary"}>{catalog ? stale ? "Stale" : "Observed" : "Not observed"}</Badge>{catalog && Date.parse(catalog.observedAt) > 0 ? <span>Observed <Time at={Date.parse(catalog.observedAt)} /></span> : null}</div>
    {resource?.error || catalog?.error || runtime?.error ? <Alert variant="destructive"><AlertDescription>{resource?.error ?? catalog?.error ?? runtime?.error}</AlertDescription></Alert> : null}
  </>;
}

export function CatalogWindow() {
  const { workerAccounts, workerRuntimes, workerCatalogs, catalogPending, status, endpoints } = useStack();
  const [query, setQuery] = useState("");
  const inputId = useId();
  const labels = workerAccountLabels(workerAccounts.data);
  const needle = query.trim().toLowerCase();
  const cards = (workerAccounts.data ?? []).map((account) => {
    const resource = workerCatalogs[account.id];
    const catalog = resource?.data;
    const label = labels.get(account.id) ?? shortId(account.id);
    const all = `${label} ${account.id} ${account.provider}`.toLowerCase().includes(needle);
    const models = catalog?.models.filter((model) => all || `${model.id} ${model.name} ${model.efforts.join(" ")}`.toLowerCase().includes(needle)) ?? [];
    const native = catalog?.nativeModelIds.filter((id) => all || id.toLowerCase().includes(needle)) ?? [];
    if (!all && !models.length && !native.length) return null;
    const node = { kind: "worker-catalog" as const, id: account.id };
    const available = account.ready && account.enabled && !account.removing;
    return <NodeCard key={account.id} node={node} label={`${label} model catalog`}>
      <div className="flex items-center justify-between gap-2"><NodeTitle node={node} label={`${label} model catalog`} className="text-sm font-medium">{label}</NodeTitle><span className="text-xs text-muted-foreground">{providerTitle(account.provider)}</span></div>
      <CatalogStatus id={account.id} />
      {!available ? <p className="text-xs text-muted-foreground">{account.removing ? "Account removal in progress." : !account.ready ? "Sign in to observe this account’s models." : "Enable this account to observe its models."}</p> : null}
      {catalog ? <>
        <p className="break-words text-xs text-muted-foreground">{catalog.source} · {catalog.runtimeVersion}</p>
        <ul className="flex flex-col gap-2">{models.map((model) => <li key={model.id} className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{model.name}</span><code className="break-all text-xs text-muted-foreground">{model.id}</code>
          <span className="text-xs">{model.efforts.length ? `Efforts: ${model.efforts.join(", ")}` : "No effort choices advertised"}</span>
        </li>)}</ul>
        {native.length ? <details><summary className="cursor-pointer text-xs font-medium">Native Devin model IDs · {native.length}</summary><p className="my-2 text-xs text-muted-foreground">Separate native evidence; not ACP model choices.</p><ul>{native.map((id) => <li key={id} className="break-all font-mono text-xs">{id}</li>)}</ul></details> : null}
        <p className="text-xs text-muted-foreground">{models.length} of {catalog.models.length} ACP models</p>
      </> : catalogPending[account.id] ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />Reading account catalog…</p> : null}
      <div><CatalogRefresh id={account.id} /></div>
    </NodeCard>;
  }).filter(Boolean);
  return (
    <Window id="model-catalogs" title="Model catalogs" subtitle="workers · account-bound choices" icon={ListTreeIcon} accent="bots" status={status.workers} endpoint={endpoints.workers} error={workerAccounts.error ?? workerRuntimes.error}>
      <p className="text-xs text-muted-foreground">Models and dependent effort choices observed without a turn. A catalog is not proof of available quota. Bot launch settings use the separate Codex runtime.</p>
      <Field><FieldLabel htmlFor={inputId}>Find models</FieldLabel><Input id={inputId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Model, effort, provider, or account…" /></Field>
      <div data-scroll className="flex max-h-[42rem] flex-col gap-3 overflow-y-auto overscroll-contain">
        {cards}
        {workerAccounts.data?.length && !cards.length ? <Empty icon={ListTreeIcon} title="No matching models">Try another model, effort, provider, or account.</Empty> : null}
        {!workerAccounts.data?.length ? <Empty icon={ListTreeIcon} title="No Worker accounts">Add and sign in to a Worker account to see its live model catalog.</Empty> : null}
      </div>
    </Window>
  );
}
