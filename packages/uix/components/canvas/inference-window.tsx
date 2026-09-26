"use client";

import { useId, useRef, useState } from "react";
import { KeyRoundIcon, PlayIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountLabels, inferenceFailure } from "@/lib/stack/derive";
import type { InferCompletion, InferEffort, InferModel, InferModels } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { CopyButton, Empty, Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { Section, Window } from "./window";

/** Mirror infer_complete's input limits. */
const limits = { instructions: 32_000, input: 128_000, maxOutputTokens: 8_192 };
const keptRuns = 10;

type Discovery = { models: InferModel[] | null; at: number | null; error: string | null; pending: boolean };
type Run = InferCompletion & { accountId: string; effort: InferEffort; instructions: string; input: string; ms: number; at: number };

const labelClass = "px-0.5 text-[0.7rem] font-medium text-muted-foreground";
const count = (value: number | null) => value === null ? "?" : value.toLocaleString();

/**
 * Lab experiment: one-shot, non-agentic inference through the `infer` API on an
 * explicitly chosen Bot account. Choosing an account discovers its models (an
 * app-server `model/list`, no inference); each Run makes exactly one request that
 * spends that account's Codex allowance. A failure is shown in place and never
 * retried, since an interrupted request may already have been charged.
 */
export function InferenceWindow() {
  const store = useStore();
  const { accounts, status, endpoints } = useStack();
  const labels = accountLabels(accounts.data);
  const formId = useId();
  const [accountId, setAccountId] = useState("");
  const [discoveries, setDiscoveries] = useState<Record<string, Discovery>>({});
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<InferEffort | "">("");
  const [instructions, setInstructions] = useState("Answer concisely.");
  const [input, setInput] = useState("");
  const [maxTokens, setMaxTokens] = useState("256");
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [failure, setFailure] = useState<ReturnType<typeof inferenceFailure> | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  const discovery = accountId ? discoveries[accountId] : undefined;
  const offered = discovery?.models ?? [];
  // Choices are preferences: an unoffered model falls back to the first, an unsupported effort to the model's default.
  const chosen = offered.find((item) => item.id === model) ?? offered[0];
  const chosenEffort = chosen ? effort && chosen.supportedEfforts.includes(effort) ? effort : chosen.defaultEffort : null;
  const tokens = Number(maxTokens);
  const tokensValid = Number.isInteger(tokens) && tokens >= 1 && tokens <= limits.maxOutputTokens;
  const account = accounts.data?.find((item) => item.id === accountId);
  const label = labels.get(accountId) ?? "this account";
  const connected = status.infer === "open";
  const blocked = !endpoints.infer ? "Inference isn't served by this owner"
    : !connected ? "Inference reconnecting"
    : !accountId ? "Choose a Bot account"
    : !account?.enabled || account.removing ? "Account unavailable"
    : discovery?.pending && !discovery.models ? "Discovering models…"
    : !chosen || !chosenEffort ? discovery?.models ? "No models offered" : "Discover models first"
    : !instructions.trim() ? "Add instructions"
    : !input.trim() ? "Write a prompt"
    : !tokensValid ? `Max tokens is 1–${limits.maxOutputTokens.toLocaleString()}`
    : null;
  const canRun = !blocked && !running;

  const discover = async (id: string) => {
    setDiscoveries((all) => ({ ...all, [id]: { models: all[id]?.models ?? null, at: all[id]?.at ?? null, error: null, pending: true } }));
    try {
      const result = await store.call<InferModels>("infer", "infer_models", { accountId: id });
      setDiscoveries((all) => ({ ...all, [id]: { models: result.models, at: Date.parse(result.observedAt), error: null, pending: false } }));
    } catch (cause) {
      setDiscoveries((all) => ({ ...all, [id]: { ...all[id]!, error: errorMessage(cause), pending: false } }));
    }
  };

  // Choosing an account is the explicit act that discovers its models once; the refresh control repeats it.
  const selectAccount = (id: string) => {
    setAccountId(id);
    setFailure(null);
    if (id && !discoveries[id]) void discover(id);
  };

  const run = async () => {
    if (!canRun || runningRef.current || !chosen || !chosenEffort) return;
    const request = { accountId, model: chosen.id, effort: chosenEffort, instructions: instructions.trim(), input: input.trim(), maxOutputTokens: tokens };
    runningRef.current = true;
    setRunning(true);
    setFailure(null);
    const started = performance.now();
    try {
      const result = await store.call<InferCompletion>("infer", "infer_complete", request);
      const ms = Math.round(performance.now() - started);
      setRuns((list) => [{ ...request, ...result, ms, at: Date.now() }, ...list].slice(0, keptRuns));
    } catch (cause) {
      setFailure(inferenceFailure(errorMessage(cause)));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const runOnModEnter = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void run();
  };

  const reuse = (item: Run) => {
    setInstructions(item.instructions);
    setInput(item.input);
    setFailure(null);
  };

  return (
    <Window id="inference" title="Inference" icon={SparklesIcon} accent="bots" count={runs.length || null}
      status={status.infer} endpoint={endpoints.infer} updatedAt={discovery?.at ?? null} empty={!accounts.data?.length && !runs.length}>
      {accounts.data?.length ? (
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-account`} className={labelClass}>Account</label>
            <div className="flex items-center gap-1.5">
              <NativeSelect id={`${formId}-account`} className="min-w-0 flex-1" value={accountId} disabled={running} onChange={(event) => selectAccount(event.target.value)}>
                <NativeSelectOption value="" disabled>Choose a Bot account</NativeSelectOption>
                {accounts.data.map((item) => (
                  <NativeSelectOption key={item.id} value={item.id} disabled={!item.enabled || item.removing}>
                    {labels.get(item.id) ?? item.id}{item.removing ? " · removing" : !item.enabled ? " · disabled" : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Tooltip>
                <TooltipTrigger render={<Button type="button" size="icon-sm" variant="ghost" aria-label="Discover models again"
                  disabled={!accountId || !connected || discovery?.pending || running} onClick={() => void discover(accountId)} />}>
                  {discovery?.pending ? <Spinner /> : <RefreshCwIcon />}
                </TooltipTrigger>
                <TooltipContent side="bottom">Discover models again</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {discovery ? (
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-1.5">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={`${formId}-model`} className={labelClass}>Model</label>
                  <NativeSelect id={`${formId}-model`} className="w-full" value={chosen?.id ?? ""} disabled={!offered.length || running}
                    onChange={(event) => setModel(event.target.value)}>
                    {offered.length ? null : <NativeSelectOption value="">{discovery.pending ? "Discovering…" : "No models"}</NativeSelectOption>}
                    {offered.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.id}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={`${formId}-effort`} className={labelClass}>Effort</label>
                  <NativeSelect id={`${formId}-effort`} className="w-full" value={chosenEffort ?? ""} disabled={!chosen || running}
                    onChange={(event) => setEffort(event.target.value as InferEffort)}>
                    {chosen ? null : <NativeSelectOption value="">—</NativeSelectOption>}
                    {chosen?.supportedEfforts.map((level) => (
                      <NativeSelectOption key={level} value={level}>{level}{level === chosen.defaultEffort ? " (default)" : ""}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <p role="status" className="px-0.5 text-[0.68rem] text-muted-foreground">
                {discovery.error ? <span className="text-destructive">{inferenceFailure(discovery.error).text}</span>
                  : discovery.pending ? "Discovering models…"
                  : <>{offered.length} model{offered.length === 1 ? "" : "s"} · observed <Time at={discovery.at} /></>}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-instructions`} className={labelClass}>Instructions</label>
            <Textarea id={`${formId}-instructions`} value={instructions} maxLength={limits.instructions} disabled={running}
              onChange={(event) => { setInstructions(event.target.value); setFailure(null); }} onKeyDown={runOnModEnter}
              className="max-h-28 min-h-9 resize-none text-[0.8rem] md:text-[0.8rem]" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-input`} className={labelClass}>Prompt</label>
            <Textarea id={`${formId}-input`} value={input} maxLength={limits.input} disabled={running} placeholder="Ask something"
              onChange={(event) => { setInput(event.target.value); setFailure(null); }} onKeyDown={runOnModEnter}
              className="max-h-48 min-h-20 resize-none" />
          </div>
          {failure ? (
            <div role="alert" className="flex flex-col gap-0.5 text-[0.72rem] text-destructive">
              <p className="text-pretty">{failure.text}</p>
              {failure.requestId ? <p className="font-mono text-[0.65rem]">request {failure.requestId}</p>
                : failure.code !== failure.text ? <p className="font-mono text-[0.65rem]">{failure.code}</p> : null}
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${formId}-tokens`} className={labelClass} title="Checked against returned usage after generation; this backend cannot cap generation or spend.">Token threshold</label>
              <Input id={`${formId}-tokens`} type="number" inputMode="numeric" min={1} max={limits.maxOutputTokens} step={1} value={maxTokens} disabled={running}
                aria-invalid={tokensValid ? undefined : true} onChange={(event) => setMaxTokens(event.target.value)} className="h-7 w-20 tabular-nums" />
            </div>
            <span className="mb-1.5 min-w-0 flex-1 text-[0.68rem] text-pretty text-muted-foreground">
              {running ? `Running on ${label}…` : blocked ?? `⌘Enter to run · spends ${label}'s Codex allowance`}
            </span>
            <Button type="submit" size="sm" disabled={!canRun}>
              {running ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
              Run
            </Button>
          </div>
        </form>
      ) : (
        <Empty icon={KeyRoundIcon} title="No Bot accounts" />
      )}
      {runs.length ? (
        <Section title="Runs" aside={<span className="text-[0.65rem] text-muted-foreground">Recent on this page</span>}>
          <ul className="flex flex-col gap-1.5">
            {runs.map((item) => (
              <li key={item.requestId} className="group/row flex flex-col gap-1.5 rounded-xl border p-2.5">
                <p className="text-[0.8rem] text-pretty whitespace-pre-wrap">{item.text || <span className="text-muted-foreground italic">Empty response</span>}</p>
                <div className="flex items-start gap-1">
                  <span className="min-w-0 flex-1 pt-1 font-mono text-[0.65rem] text-pretty text-muted-foreground"
                    title={`Request ${item.requestId} on ${labels.get(item.accountId) ?? item.accountId}`}>
                    {item.model} · {item.effort} · {count(item.usage.inputTokens)} in · {count(item.usage.outputTokens)} out
                    {item.usage.reasoningTokens ? ` (${count(item.usage.reasoningTokens)} reasoning)` : ""} · {(item.ms / 1_000).toFixed(1)}s · <Time at={item.at} />
                  </span>
                  <CopyButton value={item.text} label="output" />
                  <Button type="button" size="xs" variant="ghost" onClick={() => reuse(item)}>Reuse prompt</Button>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </Window>
  );
}
