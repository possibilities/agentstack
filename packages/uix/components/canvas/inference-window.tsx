"use client";

import { useEffect, useId, useState } from "react";
import { CircleCheckIcon, CircleHelpIcon, CircleXIcon, KeyRoundIcon, PlayIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountLabels, inferAdmission, inferErrorText } from "@/lib/stack/derive";
import type { InferEffort, InferRequest, InferRequestState, InferRequestSummary } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { CopyButton, Empty, Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { Section, Window } from "./window";

/** Mirror infer_start's input limits. */
const limits = { instructions: 32_000, input: 128_000, maxOutputTokens: 8_192 };

type StartRequest = { requestId: string; accountId: string; model: string; effort: InferEffort; instructions: string; input: string; maxOutputTokens: number };
type Admission = { request: StartRequest; sending: boolean; error: ReturnType<typeof inferAdmission> | null };

const labelClass = "px-0.5 text-[0.7rem] font-medium text-muted-foreground";
const count = (value: number | null) => value === null ? "?" : value.toLocaleString();
const stateView: Record<InferRequestState, { label: string; icon: React.ReactNode; className: string }> = {
  running: { label: "Running", icon: <Spinner className="size-3" />, className: "text-muted-foreground" },
  completed: { label: "Completed", icon: <CircleCheckIcon className="size-3" />, className: "text-success" },
  failed: { label: "Failed", icon: <CircleXIcon className="size-3" />, className: "text-destructive" },
  unknown: { label: "Outcome unknown", icon: <CircleHelpIcon className="size-3" />, className: "text-warning" },
};

function seconds(item: InferRequestSummary): string | null {
  return item.finishedAt ? `${((Date.parse(item.finishedAt) - Date.parse(item.createdAt)) / 1_000).toFixed(1)}s` : null;
}

/**
 * Lab experiment over the `infer` Package API. Choosing a Bot account discovers
 * its models (no inference); Run admits one request into infer's durable ledger,
 * which spends that account's Codex allowance. Requests, outcomes and model
 * discovery are server state, re-read after `infer_changed`; an unconfirmed
 * admission is resent with the same request ID, never as a new request.
 */
export function InferenceWindow() {
  const store = useStore();
  const { accounts, status, endpoints, inferModels, inferRequests } = useStack();
  const labels = accountLabels(accounts.data);
  const formId = useId();
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<InferEffort | "">("");
  const [instructions, setInstructions] = useState("Answer concisely.");
  const [input, setInput] = useState("");
  const [maxTokens, setMaxTokens] = useState("256");
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [admission, setAdmission] = useState<Admission | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, InferRequest>>({});
  const [detailError, setDetailError] = useState<string | null>(null);

  const requests = inferRequests.data ?? [];
  const observation = inferModels.data?.find((item) => item.accountId === accountId);
  const offered = observation?.models ?? [];
  // Choices are preferences: an unoffered model falls back to the first, an unsupported effort to the model's default.
  const chosen = offered.find((item) => item.id === model) ?? offered[0];
  const chosenEffort = chosen ? effort && chosen.supportedEfforts.includes(effort) ? effort : chosen.defaultEffort : null;
  const tokens = Number(maxTokens);
  const tokensValid = Number.isInteger(tokens) && tokens >= 1 && tokens <= limits.maxOutputTokens;
  const account = accounts.data?.find((item) => item.id === accountId);
  const label = labels.get(accountId) ?? "this account";
  const connected = status.infer === "open";
  const runningHere = requests.some((item) => item.accountId === accountId && item.state === "running");
  // Once the ledger lists an unconfirmed request, it was admitted.
  const pending = admission && !requests.some((item) => item.requestId === admission.request.requestId) ? admission : null;
  const blocked = !endpoints.infer ? "Inference isn't served by this owner"
    : !connected ? "Inference reconnecting"
    : !accountId ? "Choose a Bot account"
    : !account?.enabled || account.removing ? "Account unavailable"
    : observation?.discovering && !observation.models ? "Discovering models…"
    : !chosen || !chosenEffort ? observation?.models ? "No models offered" : "Discover models first"
    : runningHere ? "A request is running on this account"
    : !instructions.trim() ? "Add instructions"
    : !input.trim() ? "Write a prompt"
    : !tokensValid ? `Token threshold is 1–${limits.maxOutputTokens.toLocaleString()}`
    : null;
  const canRun = !blocked && !pending?.sending;

  const expandedSummary = requests.find((item) => item.requestId === expanded);
  // Re-read the full record whenever the followed request changes state.
  const detailKey = expanded && connected ? `${expanded}:${expandedSummary?.state ?? "unlisted"}` : null;
  useEffect(() => {
    if (!detailKey) return;
    const requestId = detailKey.slice(0, detailKey.indexOf(":"));
    let live = true;
    setDetailError(null);
    store.call<InferRequest>("infer", "infer_request_get", { requestId }).then(
      (record) => { if (live) setDetails((all) => ({ ...all, [record.requestId]: record })); },
      (cause) => { if (live) setDetailError(inferErrorText(errorMessage(cause))); });
    return () => { live = false; };
  }, [detailKey, store]);

  const discover = (id: string) => {
    setDiscoverError(null);
    store.infer("infer_discover", { accountId: id }).catch((cause) => setDiscoverError(inferErrorText(errorMessage(cause))));
  };

  // Choosing an account discovers its models only when none are cached; the refresh control repeats it.
  const selectAccount = (id: string) => {
    setAccountId(id);
    if (id && !inferModels.data?.some((item) => item.accountId === id)) discover(id);
    else setDiscoverError(null);
  };

  const submit = async (request: StartRequest) => {
    setAdmission({ request, sending: true, error: null });
    // Follow it even if the acknowledgement is lost; the ledger shows it once admitted.
    setExpanded(request.requestId);
    try {
      const record = await store.infer<InferRequest>("infer_start", request);
      setDetails((all) => ({ ...all, [record.requestId]: record }));
      setAdmission(null);
    } catch (cause) {
      setAdmission({ request, sending: false, error: inferAdmission(errorMessage(cause)) });
    }
  };

  const run = () => {
    if (!canRun || !chosen || !chosenEffort) return;
    void submit({ requestId: crypto.randomUUID(), accountId, model: chosen.id, effort: chosenEffort,
      instructions: instructions.trim(), input: input.trim(), maxOutputTokens: tokens });
  };

  const runOnModEnter = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    run();
  };

  const reuse = (record: InferRequest) => {
    setInstructions(record.instructions);
    setInput(record.input);
    setAdmission(null);
  };

  return (
    <Window id="inference" title="Inference" icon={SparklesIcon} accent="bots" count={requests.length || null}
      status={status.infer} endpoint={endpoints.infer} updatedAt={inferRequests.at} error={inferRequests.error}
      empty={!accounts.data?.length && !requests.length}>
      {accounts.data?.length ? (
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); run(); }}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-account`} className={labelClass}>Account</label>
            <div className="flex items-center gap-1.5">
              <NativeSelect id={`${formId}-account`} className="min-w-0 flex-1" value={accountId} onChange={(event) => selectAccount(event.target.value)}>
                <NativeSelectOption value="" disabled>Choose a Bot account</NativeSelectOption>
                {accounts.data.map((item) => (
                  <NativeSelectOption key={item.id} value={item.id} disabled={!item.enabled || item.removing}>
                    {labels.get(item.id) ?? item.id}{item.removing ? " · removing" : !item.enabled ? " · disabled" : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Tooltip>
                <TooltipTrigger render={<Button type="button" size="icon-sm" variant="ghost" aria-label="Discover models again"
                  disabled={!accountId || !connected || observation?.discovering} onClick={() => discover(accountId)} />}>
                  {observation?.discovering ? <Spinner /> : <RefreshCwIcon />}
                </TooltipTrigger>
                <TooltipContent side="bottom">Discover models again</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {accountId && (observation || discoverError) ? (
            <div className="flex flex-col gap-1.5">
              {observation ? (
                <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-1.5">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <label htmlFor={`${formId}-model`} className={labelClass}>Model</label>
                    <NativeSelect id={`${formId}-model`} className="w-full" value={chosen?.id ?? ""} disabled={!offered.length}
                      onChange={(event) => setModel(event.target.value)}>
                      {offered.length ? null : <NativeSelectOption value="">{observation.discovering ? "Discovering…" : "No models"}</NativeSelectOption>}
                      {offered.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.id}</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <label htmlFor={`${formId}-effort`} className={labelClass}>Effort</label>
                    <NativeSelect id={`${formId}-effort`} className="w-full" value={chosenEffort ?? ""} disabled={!chosen}
                      onChange={(event) => setEffort(event.target.value as InferEffort)}>
                      {chosen ? null : <NativeSelectOption value="">—</NativeSelectOption>}
                      {chosen?.supportedEfforts.map((level) => (
                        <NativeSelectOption key={level} value={level}>{level}{level === chosen.defaultEffort ? " (default)" : ""}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                </div>
              ) : null}
              <p role="status" className="px-0.5 text-[0.68rem] text-muted-foreground">
                {discoverError ? <span className="text-destructive">{discoverError}</span>
                  : observation?.discovering ? "Discovering models…"
                  : observation?.error ? <span className="text-destructive">{inferErrorText(observation.error)}</span>
                  : observation ? <>{offered.length} model{offered.length === 1 ? "" : "s"} · observed <Time at={observation.observedAt ? Date.parse(observation.observedAt) : null} /></>
                  : null}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-instructions`} className={labelClass}>Instructions</label>
            <Textarea id={`${formId}-instructions`} value={instructions} maxLength={limits.instructions}
              onChange={(event) => setInstructions(event.target.value)} onKeyDown={runOnModEnter}
              className="max-h-28 min-h-9 resize-none text-[0.8rem] md:text-[0.8rem]" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-input`} className={labelClass}>Prompt</label>
            <Textarea id={`${formId}-input`} value={input} maxLength={limits.input} placeholder="Ask something"
              onChange={(event) => setInput(event.target.value)} onKeyDown={runOnModEnter}
              className="max-h-48 min-h-20 resize-none" />
          </div>
          {pending?.error ? (
            <div role="alert" className="flex flex-col items-start gap-1.5 text-[0.72rem] text-destructive">
              <p className="text-pretty">{pending.error.text}</p>
              {pending.error.uncertain ? (
                <div className="flex gap-1.5">
                  <Button type="button" size="xs" variant="outline" disabled={!connected} onClick={() => void submit(pending.request)}>Resend</Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setAdmission(null)}>Dismiss</Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${formId}-tokens`} className={labelClass} title="Checked against returned usage after generation; this backend cannot cap generation or spend.">Token threshold</label>
              <Input id={`${formId}-tokens`} type="number" inputMode="numeric" min={1} max={limits.maxOutputTokens} step={1} value={maxTokens}
                aria-invalid={tokensValid ? undefined : true} onChange={(event) => setMaxTokens(event.target.value)} className="h-7 w-20 tabular-nums" />
            </div>
            <span className="mb-1.5 min-w-0 flex-1 text-[0.68rem] text-pretty text-muted-foreground">
              {pending?.sending ? "Starting…" : blocked ?? `⌘Enter to run · spends ${label}'s Codex allowance`}
            </span>
            <Button type="submit" size="sm" disabled={!canRun}>
              {pending?.sending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
              Run
            </Button>
          </div>
        </form>
      ) : (
        <Empty icon={KeyRoundIcon} title="No Bot accounts" />
      )}
      {requests.length ? (
        <Section title="Requests" aside={<span className="text-[0.65rem] text-muted-foreground">Newest {requests.length}</span>}>
          <ul className="flex flex-col gap-1.5">
            {requests.map((item) => {
              const view = stateView[item.state];
              const open = expanded === item.requestId;
              const detail = open ? details[item.requestId] : undefined;
              const elapsed = seconds(item);
              return (
                <li key={item.requestId} className="group/row flex flex-col rounded-xl border">
                  <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? null : item.requestId)}
                    className="flex flex-col gap-1 rounded-xl px-2.5 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring">
                    <span className={cn("flex items-center gap-1 text-[0.68rem] font-medium", view.className)}>{view.icon}{view.label}</span>
                    {open ? null : (
                      <span className={cn("line-clamp-2 text-[0.8rem] text-pretty", item.textPreview === null && "text-muted-foreground")}>
                        {item.textPreview ?? item.inputPreview}
                      </span>
                    )}
                    <span className="font-mono text-[0.65rem] text-pretty text-muted-foreground">
                      {item.model}{item.reportedModel && item.reportedModel !== item.model ? ` (reported ${item.reportedModel})` : ""} · {item.effort}
                      {item.usage ? ` · ${count(item.usage.inputTokens)} in · ${count(item.usage.outputTokens)} out` : ""}
                      {item.usage?.reasoningTokens ? ` (${count(item.usage.reasoningTokens)} reasoning)` : ""}
                      {elapsed ? ` · ${elapsed}` : ""} · {labels.get(item.accountId) ?? item.accountId.slice(0, 8)} · <Time at={Date.parse(item.createdAt)} />
                    </span>
                  </button>
                  {open ? (
                    <div className="flex flex-col gap-2 border-t px-2.5 py-2">
                      {item.error ? <p className={cn("text-[0.72rem] text-pretty", view.className)}>{inferErrorText(item.error)}</p> : null}
                      {detail ? (
                        <>
                          {detail.text !== null ? (
                            <div className="flex items-start gap-1">
                              <p className="min-w-0 flex-1 text-[0.8rem] text-pretty whitespace-pre-wrap">{detail.text || <span className="text-muted-foreground italic">Empty response</span>}</p>
                              <CopyButton value={detail.text} label="output" />
                            </div>
                          ) : null}
                          <div className="flex flex-col gap-0.5">
                            <span className={labelClass}>Prompt</span>
                            <p className="px-0.5 text-[0.75rem] text-pretty whitespace-pre-wrap text-muted-foreground">{detail.input}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="min-w-0 flex-1 truncate font-mono text-[0.65rem] text-muted-foreground" title={detail.requestId}>request {detail.requestId}</span>
                            <CopyButton value={detail.requestId} label="request ID" />
                            <Button type="button" size="xs" variant="ghost" onClick={() => reuse(detail)}>Reuse prompt</Button>
                          </div>
                        </>
                      ) : detailError ? <p className="text-[0.72rem] text-destructive">{detailError}</p>
                        : <p className="text-[0.72rem] text-muted-foreground">Loading…</p>}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
    </Window>
  );
}
