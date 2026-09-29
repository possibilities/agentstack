"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { botChoices, type SettingsTarget } from "@/lib/stack/settings";
import type { Bot, BotSettingsOptions, JsonSchema, SettingsCatalog, SettingsDiscovery } from "@/lib/stack/types";
import { RecordTree } from "./record-tree";
import { Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { SettingsEditor, useSettings, type ExtraEvidence } from "./settings-editor";

type BotTarget = Extract<SettingsTarget, { kind: "bot" | "bot-defaults" }>;
type Options = { key: string; data: BotSettingsOptions | null; error: string | null; pending: boolean };

const discoverable = (bot: Bot | undefined): bot is Bot => Boolean(bot && bot.state === "running" && !bot.recoveryIssue && bot.url);

/**
 * Native model, voice, feature and requirement discovery from one verified running Bot, read once per
 * runtime instance and on explicit refresh. It starts no thread, turn or media, and a stopped Bot has none.
 */
function useBotOptions(bot: Bot | undefined, instance: string | null): Options & { refresh(): void } {
  const store = useStore();
  const key = discoverable(bot) ? `${bot.id}:${instance ?? bot.url}` : null;
  const [options, setOptions] = useState<Options>({ key: "", data: null, error: null, pending: false });
  const current = useRef(key);
  current.current = key;
  const read = useCallback((id: string, readKey: string) => {
    setOptions((held) => ({ key: readKey, data: held.key === readKey ? held.data : null, error: null, pending: true }));
    store.call<BotSettingsOptions>("bots", "bot_settings_options", { id }).then(
      (data) => { if (current.current === readKey) setOptions({ key: readKey, data, error: null, pending: false }); },
      (error: Error) => { if (current.current === readKey) setOptions((held) => ({ key: readKey, data: held.key === readKey ? held.data : null, error: error.message, pending: false })); });
  }, [store]);
  const id = bot?.id;
  useEffect(() => { if (key && id) read(id, key); }, [key, id, read]);
  const shown = key && options.key === key ? options : { key: key ?? "", data: null, error: null, pending: false };
  return { ...shown, refresh: () => { if (key && id) read(id, key); } };
}

function Part<T>({ label, part, count }: { label: string; part: SettingsDiscovery<T>; count?: number | null }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      {part.available ? <span>{part.data === null ? "none" : count ?? "available"}</span> : <span className="text-destructive" title={part.issue ?? undefined}>unavailable</span>}
    </span>
  );
}

/** What live discovery returned, part by part: a failed part never hides the others. */
function Discovery({ source, options, bots, reference, onReference, defaults }: {
  source: Bot | undefined;
  options: Options & { refresh(): void };
  bots: Bot[];
  reference: string;
  onReference(id: string): void;
  defaults: boolean;
}) {
  const data = options.data;
  const running = bots.filter(discoverable);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-2 text-[0.72rem]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Native choices</span>
        {defaults ? (
          <NativeSelect size="sm" aria-label="Reference Bot for native choices" className="min-w-0" value={reference} onChange={(event) => onReference(event.target.value)}>
            <NativeSelectOption value="">No reference Bot</NativeSelectOption>
            {running.map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{bot.id}</NativeSelectOption>)}
          </NativeSelect>
        ) : null}
        {discoverable(source) ? (
          <Button size="xs" variant="ghost" className="ml-auto" disabled={options.pending} onClick={options.refresh}>
            {options.pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Refresh
          </Button>
        ) : null}
      </div>
      {!source ? <p className="text-muted-foreground">{defaults ? "Choose a running Bot to suggest native models and voices. Suggestions come from that Bot's account and runtime; they are not guaranteed for every future Bot." : "This Bot is gone."}</p>
        : !discoverable(source) ? <p className="text-muted-foreground">Available while the Bot runs verified. Saved values stay editable; nothing is replaced while choices are unavailable.</p>
        : options.error ? <p className="text-destructive">{options.error}</p>
        : !data ? <p className="text-muted-foreground">Reading native choices from {source.id}…</p>
        : (
          <>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {defaults ? <span className="text-muted-foreground">From {source.id}</span> : null}
              <Part label="Models" part={data.models} count={data.models.data?.length} />
              <Part label="Voices" part={data.voices} count={data.voices.data ? new Set([...data.voices.data.voices.v1, ...data.voices.data.voices.v2]).size : null} />
              <Part label="Features" part={data.features} count={data.features.data?.length} />
              <Part label="Requirements" part={data.requirements} count={data.requirements.data ? Object.keys(data.requirements.data).length : null} />
              <span className="text-muted-foreground">· <Time at={data.observedAt} /></span>
            </div>
            {data.requirements.available && data.requirements.data ? (
              <details>
                <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Managed requirements</summary>
                <div className="mt-1.5"><RecordTree value={data.requirements.data} /></div>
              </details>
            ) : null}
          </>
        )}
    </div>
  );
}

/** Flatten a JSON Schema's properties into dotted paths for lookup; `$ref`s are named, not followed. */
function schemaPaths(schema: JsonSchema, prefix = "", depth = 0, out: Array<{ path: string; schema: JsonSchema }> = []): Array<{ path: string; schema: JsonSchema }> {
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({ path, schema: child });
    if (depth < 3 && child.properties) schemaPaths(child, path, depth + 1, out);
  }
  return out;
}

/** The full pinned native schema, read on first open. It is reference only: editable keys come from the managed catalog. */
function NativeSchema({ catalog }: { catalog: SettingsCatalog | null }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [schema, setSchema] = useState<{ revision: string; schema: JsonSchema } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open || schema) return;
    let live = true;
    store.call<{ revision: string; schema: JsonSchema }>("bots", "bot_settings_native_schema").then((value) => { if (live) setSchema(value); }, (cause: Error) => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [open, schema, store]);
  const managed = useMemo(() => new Set(catalog?.settings.map((definition) => definition.key) ?? []), [catalog]);
  const paths = useMemo(() => schema ? schemaPaths(schema.schema) : [], [schema]);
  const needle = query.trim().toLowerCase();
  const shown = needle ? paths.filter(({ path, schema }) => path.toLowerCase().includes(needle) || schema.description?.toLowerCase().includes(needle)).slice(0, 60) : [];
  return (
    <details className="text-[0.72rem]" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Native configuration reference</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-pretty text-muted-foreground">The complete pinned Codex configuration schema, read-only. Presence here does not make a key editable, eligible for an account, or applied by Stack.</p>
        {error ? <p className="text-destructive">{error}</p> : !schema ? <p className="text-muted-foreground">Reading schema…</p> : (
          <>
            <div className="flex items-center gap-2">
              <Input aria-label="Search native settings" className="h-7 text-xs" placeholder={`Search ${paths.length} keys`} value={query} onChange={(event) => setQuery(event.target.value)} />
              <span className="shrink-0 font-mono text-muted-foreground" title={schema.revision}>{schema.revision.slice(0, 12)}</span>
            </div>
            {needle ? (
              <ul className="flex flex-col gap-1">
                {shown.map(({ path, schema: child }) => (
                  <li key={path} className="flex flex-col">
                    <span className="flex items-baseline gap-1.5">
                      <span className="font-mono">{path}</span>
                      {managed.has(path) ? <span className="rounded bg-primary/10 px-1 text-[0.64rem] text-primary">managed</span> : null}
                      <span className="text-muted-foreground">{Array.isArray(child.type) ? child.type.join(" | ") : child.type ?? (typeof child.$ref === "string" ? child.$ref.split("/").at(-1) : child.anyOf ? "union" : "")}</span>
                    </span>
                    {child.description ? <span className="text-pretty text-muted-foreground">{child.description}</span> : null}
                  </li>
                ))}
                {!shown.length ? <li className="text-muted-foreground">No matching keys</li> : null}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

/**
 * Managed settings for one Bot, or the defaults copied into new Bots: process fields load at the next start,
 * voice fields on the next call. Saving never starts, stops or reconnects anything.
 */
export function BotSettingsPanel({ target, onDirtyChange }: { target: BotTarget; onDirtyChange?(dirty: boolean): void }) {
  const store = useStore();
  const state = useStack();
  const { view, catalog } = useSettings(target, "bots");
  const bots = state.bots.data ?? [];
  const bot = target.kind === "bot" ? bots.find((item) => item.id === target.id) : undefined;
  const [reference, setReference] = useState("");
  const source = target.kind === "bot" ? bot : bots.find((item) => item.id === reference);
  const options = useBotOptions(source, target.kind === "bot" ? view?.data?.instance ?? null : null);
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const remote = state.remote;
  const offline = state.status.bots !== "open";
  const canWrite = !offline && remote?.scope !== "view";
  const writeReason = offline ? "Bots is not connected" : remote?.scope === "view" ? "Saving requires ui:control" : null;
  const call = state.voice.data;
  const dirtyChanged = useCallback((value: boolean) => { setDirty(value); onDirtyChange?.(value); }, [onDirtyChange]);

  const features = new Map((options.data?.features.data ?? []).map((feature) => [`features.${feature.name}`, feature]));
  const extraEvidence = (definition: SettingsCatalog["settings"][number]): ExtraEvidence[] => {
    const feature = features.get(definition.key) ?? features.get(definition.key.split(".").slice(0, 2).join("."));
    return feature && definition.key.startsWith("features.") ? [{ label: "Native feature list", text: `${feature.enabled ? "enabled" : "disabled"} · default ${feature.defaultEnabled ? "on" : "off"} · ${feature.stage}` }] : [];
  };

  async function apply() {
    const data = view?.data;
    if (!bot || !data || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      await store.call("bots", "bot_settings_apply", { id: bot.id, expectedRevision: data.saved.revision });
      toast.success(`${bot.id} started with saved revision ${data.saved.revision}`);
    } catch (cause) {
      // A lost response can still mean the Bot started. The store re-reads; nothing retries a start.
      setApplyError(`${cause instanceof Error ? cause.message : String(cause)}. Check the Bot's state before trying again.`);
    } finally { setApplying(false); }
  }

  const startBlock = !bot ? "This Bot is gone." : bot.state === "running" ? null : bot.recoveryIssue ? bot.recoveryIssue : !bot.account ? "Assign an account before starting." : !canWrite ? writeReason : null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Discovery source={source} options={options} bots={bots} reference={reference} onReference={setReference} defaults={target.kind === "bot-defaults"} />
      {target.kind === "bot" && bot ? (
        <div className="flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-[0.72rem]">
          {bot.state === "running" ? (
            <p className="text-pretty text-muted-foreground">Running. Saved process settings load on its next start; saving never restarts it. Stop it with its lifecycle controls when you choose to. A resumed main thread can keep its own thread settings.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-pretty text-muted-foreground">Stopped. Starting loads saved revision {view?.data?.saved.revision ?? "…"} on its existing workspace and main thread.{dirty ? " Unsaved edits are not included." : ""}</p>
              <Button size="xs" variant="secondary" disabled={Boolean(startBlock) || applying || !view?.data} title={startBlock ?? undefined} onClick={() => void apply()}>
                {applying ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}Start with saved settings
              </Button>
            </div>
          )}
          {startBlock && bot.state !== "running" ? <p className="text-muted-foreground">{startBlock}</p> : null}
          {applyError ? <Alert variant="destructive"><AlertDescription>{applyError}</AlertDescription></Alert> : null}
        </div>
      ) : null}
      <SettingsEditor target={target} view={view?.data ?? null} viewError={view?.error ?? null} catalog={catalog?.data ?? null}
        choices={(definition, values) => botChoices(definition, options.data, values)} extraEvidence={extraEvidence}
        canWrite={canWrite} writeReason={writeReason} onDirtyChange={dirtyChanged}
        sectionNote={(boundary) => boundary !== "voice-call" || target.kind !== "bot" ? null : (
          <p className="text-[0.72rem] text-pretty text-muted-foreground">
            {remote ? "Live call state is unavailable in a remote session; call-loaded evidence here may be stale."
              : call?.botId === target.id && call.phase === "connected" ? "On a connected call with this Bot: the loaded rows show what that call received. Use the call controls to hang up or dial again."
              : call?.botId === target.id ? "Dialing this Bot: nothing is loaded until the call connects."
              : "No connected call with this Bot, so nothing is loaded for a call. Voice names are native compatibility evidence, not an audible test."}
          </p>
        )} />
      <NativeSchema catalog={catalog?.data ?? null} />
    </div>
  );
}
