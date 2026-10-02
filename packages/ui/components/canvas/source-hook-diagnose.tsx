"use client";

import { useEffect, useRef, useState } from "react";
import { ActivityIcon, ListIcon, RedoIcon, SendIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  attemptName, attemptOk, correlateAttempts, correlationSpan, correlationStart, entryWords, probeArrival, receiverName, remoteKindWords, type JournalEntry,
} from "@/lib/stack/source-setup";
import { localOperation, localOperations } from "@/lib/stack/state";
import type { GithubAttempt, GithubAttemptPage, GithubDelivery, GithubDeliveryPage, GithubEndpoint } from "@/lib/stack/types";
import { CopyButton, NodeLink } from "./primitives";
import { useStack, useStore } from "./provider";
import { codeWords } from "./source-hook-setup";
import type { RemoteRequests } from "./source-requests";
import { sourceChip, sourceHint, sourceLabel, Stamp, Word } from "./source-shared";

type Confirm = { kind: "ping" | "test" } | { kind: "redeliver"; attempt: GithubAttempt } | null;

/**
 * Diagnose a managed hook. A probe or redelivery is a request to GitHub whose answer says only that GitHub admitted it; whether a signed
 * request arrived at Stack is read separately from the receiver. GitHub's delivery attempts are upstream observation, and they are matched
 * to local arrivals by delivery GUID, never by sequence.
 */
export function HookDiagnose({ endpoint, requests }: { endpoint: GithubEndpoint; requests: RemoteRequests }) {
  const state = useStack();
  const hookId = endpoint.managedHookId;
  const connected = state.status.source === "open";
  const probe = localOperations(state, "source", ["github_hook_probe", "github_remote_receipt_get"]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const probes = requests.entries.filter((entry) => entry.kind === "ping" || entry.kind === "test");
  const latest = probes[probes.length - 1] ?? null;
  if (!hookId) {
    return <p className={sourceHint}>Probing and delivery attempts act on one exact managed hook. None is recorded for this receiver yet: apply a reviewed plan first, or note that a hook set up by hand cannot be probed from here.</p>;
  }
  const arrival = latest ? probeArrival(latest, endpoint) : null;
  const send = async (kind: "ping" | "test") => {
    const entry: JournalEntry = { requestId: crypto.randomUUID(), endpointId: endpoint.id, kind, at: Date.now(), status: "pending", hookId, startedAt: null, completedAt: null, error: null,
      intent: `${kind === "ping" ? "Ping" : "Push test"} for hook #${hookId} of ${receiverName(endpoint)}` };
    await requests.send(entry);
    setConfirm(null);
  };
  const sendRedelivery = async (attempt: GithubAttempt) => {
    const entry: JournalEntry = { requestId: crypto.randomUUID(), endpointId: endpoint.id, kind: "redeliver", at: Date.now(), status: "pending", hookId, attemptId: attempt.id, guid: attempt.guid,
      startedAt: null, completedAt: null, error: null, intent: `Redeliver attempt ${attempt.id} (${attemptName(attempt)}, GUID ${attempt.guid}) for hook #${hookId} of ${receiverName(endpoint)}` };
    await requests.send(entry);
    setConfirm(null);
  };
  return (
    <section aria-label="Probe and delivery attempts" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className={sourceLabel}>Probe hook #{hookId}</span>
        <p className={sourceHint}>Asks GitHub to send this hook a ping{endpoint.target.kind === "repository" ? " or a push event test" : ""}. GitHub answering means it admitted the request. It does not mean a signed request arrived at Stack.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={!probe.available || !connected || requests.busy !== null} title={probe.available ? undefined : probe.reason} onClick={() => setConfirm({ kind: "ping" })}><ActivityIcon data-icon="inline-start" />Request ping…</Button>
          {endpoint.target.kind === "repository" ? (
            <Button size="xs" variant="outline" disabled={!probe.available || !connected || requests.busy !== null} title={probe.available ? undefined : probe.reason} onClick={() => setConfirm({ kind: "test" })}><SendIcon data-icon="inline-start" />Request push test…</Button>
          ) : null}
        </div>
        <dl aria-label="Request and arrival" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/50 px-2.5 py-2 text-[0.72rem]">
          <dt className="text-muted-foreground">Request</dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            {latest ? <><span className="flex items-baseline gap-2"><Word tone={entryWords(latest).tone} className="text-[0.72rem]">{entryWords(latest).word}</Word><span className="text-muted-foreground">{remoteKindWords[latest.kind]} · <Stamp at={latest.at} /></span></span>
              <span className="text-muted-foreground">Receipt only: what GitHub did with the request.</span></>
              : <span className="text-muted-foreground">No probe requested from this browser.</span>}
          </dd>
          <dt className="text-muted-foreground">Arrival</dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            {arrival?.observed ? <span><Word tone="success" className="text-[0.72rem]">A {arrival.label} was observed</Word> <span className="text-muted-foreground"><Stamp at={arrival.at} />, after the request began. That fits the request but does not prove it caused it.</span></span>
              : <span><Word tone="muted" className="text-[0.72rem]">{latest ? `No ${arrival?.label} observed since` : "Observed at Stack"}</Word>
                <span className="text-muted-foreground"> · last ping {endpoint.lastPingAt ? <Stamp at={endpoint.lastPingAt} /> : "none"}, last delivery {endpoint.lastDeliveryAt ? <Stamp at={endpoint.lastDeliveryAt} /> : "none"}.{latest ? " Not yet is not never: check the public prerequisite and GitHub's attempts below." : ""}</span></span>}
          </dd>
        </dl>
      </div>
      <Attempts endpoint={endpoint} hookId={hookId} requests={requests} onRedeliver={(attempt) => setConfirm({ kind: "redeliver", attempt })} />
      <AlertDialog open={confirm !== null} onOpenChange={(next) => { if (!next && requests.busy === null) setConfirm(null); }}>
        <AlertDialogContent size="sm" aria-label="Confirm request to GitHub">
          <AlertDialogHeader>
            <AlertDialogMedia>{confirm?.kind === "redeliver" ? <RedoIcon /> : <ActivityIcon />}</AlertDialogMedia>
            <AlertDialogTitle>{confirm?.kind === "ping" ? `Ask GitHub to ping hook #${hookId}?` : confirm?.kind === "test" ? `Ask GitHub for a push test on hook #${hookId}?` : "Ask GitHub to redeliver this attempt?"}</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span><span className="font-medium text-foreground">{endpoint.label}</span> · hook #{hookId}</span>
              {confirm?.kind === "redeliver" ? (
                <>
                  <span>Attempt <code className="font-mono text-[0.68rem]">{confirm.attempt.id}</code>, <code className="font-mono text-[0.68rem]">{attemptName(confirm.attempt)}</code>, answered {confirm.attempt.statusCode} {confirm.attempt.status}. GUID <code className="font-mono text-[0.68rem] break-all">{confirm.attempt.guid}</code>.</span>
                  <span>GitHub resends this one attempt once. If Stack already holds this GUID the arrival is recognized as a duplicate: no second sequence and no new watch entry. A payload that was cleared is not restored. GitHub&rsquo;s answer is admission, not arrival.</span>
                </>
              ) : <span>GitHub sends one {confirm?.kind === "test" ? "push event for the repository's latest commit" : "ping"} to the hook&rsquo;s URL. GitHub&rsquo;s answer is admission, not arrival: whether a signed request reaches Stack is shown separately.</span>}
              <span>A request ID is recorded in this browser before sending. If the answer is lost its receipt is read under the same ID; it is never sent again under a new one.</span>
              {requests.waiting ? <span role="status" className="text-foreground">{requests.waiting}</span> : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="group-data-[size=sm]/alert-dialog-content:grid-cols-1">
            <AlertDialogCancel disabled={requests.busy !== null}>Cancel</AlertDialogCancel>
            <Button disabled={requests.busy !== null || !confirm || Boolean(requests.waiting)} onClick={() => { if (confirm?.kind === "redeliver") void sendRedelivery(confirm.attempt); else if (confirm) void send(confirm.kind); }}>
              {requests.busy !== null ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}{confirm?.kind === "redeliver" ? "Request redelivery" : confirm?.kind === "test" ? "Request push test" : "Request ping"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Attempts({ endpoint, hookId, requests, onRedeliver }: { endpoint: GithubEndpoint; hookId: number; requests: RemoteRequests; onRedeliver(attempt: GithubAttempt): void }) {
  const store = useStore();
  const state = useStack();
  const connected = state.status.source === "open";
  const read = localOperation(state, "source", "github_hook_deliveries");
  const redeliver = localOperations(state, "source", ["github_hook_redeliver", "github_remote_receipt_get"]);
  const [attempts, setAttempts] = useState<GithubAttempt[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Record<string, number>>({});
  const [searched, setSearched] = useState<{ from: number; to: number } | null>(null);
  const [matching, setMatching] = useState(false);
  const back = useRef(correlationSpan);
  const latestSequence = state.sourceStatus.data?.latestSequence ?? null;
  // Another receiver or a new hook starts the list over: an attempt belongs to exactly one hook.
  useEffect(() => { setAttempts(null); setCursor(null); setMatches({}); setSearched(null); setError(null); back.current = correlationSpan; }, [endpoint.id, hookId]);

  /** Local arrivals of this receiver after a sequence, paged and bounded: a read, matched by GUID. */
  const correlate = async (shown: GithubAttempt[], reach: number) => {
    if (latestSequence === null) return;
    setMatching(true);
    try {
      const start = correlationStart(latestSequence, reach), local: GithubDelivery[] = [];
      let after = start, through: number | undefined;
      for (let page = 0; page < 12; page++) {
        const result: GithubDeliveryPage = await store.call<GithubDeliveryPage>("source", "github_delivery_list", { after, ...(through === undefined ? {} : { through }), limit: 50, filter: { endpointIds: [endpoint.id] } });
        through = result.through; local.push(...result.entries);
        if (result.nextCursor === null) break;
        after = result.nextCursor;
      }
      setMatches(correlateAttempts(shown, local, endpoint.id)); setSearched({ from: start + 1, to: through ?? latestSequence });
    } catch { /* matching is a convenience read; the attempts stay readable without it */ } finally { setMatching(false); }
  };
  const load = async (next: string | null) => {
    setLoading(true); setError(null);
    try {
      const page = await store.call<GithubAttemptPage>("source", "github_hook_deliveries", { endpointId: endpoint.id, hookId, ...(next ? { cursor: next } : {}) });
      const merged = next && attempts ? [...attempts, ...page.entries.filter((entry) => !attempts.some((held) => held.id === entry.id))] : page.entries;
      setAttempts(merged); setCursor(page.nextCursor);
      void correlate(merged, back.current);
    } catch (failure) { setError(codeWords(failure)); } finally { setLoading(false); }
  };
  const further = () => { back.current += correlationSpan; if (attempts) void correlate(attempts, back.current); };
  const pendingFor = (attempt: GithubAttempt) => requests.entries.find((entry) => entry.kind === "redeliver" && entry.attemptId === attempt.id && (entry.status === "pending" || entry.status === "running" || entry.status === "unknown"));
  return (
    <div className="flex flex-col gap-1.5">
      <span className={sourceLabel}>GitHub&rsquo;s delivery attempts</span>
      <p className={sourceHint}>What GitHub says it tried to send to this hook, including failures. This is upstream observation, not what Stack admitted. GitHub does not redeliver failures on its own.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" disabled={!read.available || !connected || loading} title={read.available ? undefined : read.reason} onClick={() => void load(null)}>
          {loading && !cursor ? <Spinner data-icon="inline-start" /> : <ListIcon data-icon="inline-start" />}{attempts ? "Read attempts again" : "Read attempts"}
        </Button>
      </div>
      {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
      {attempts ? (
        <>
          <p className="text-[0.7rem] text-muted-foreground tabular-nums">{attempts.length} {attempts.length === 1 ? "attempt" : "attempts"} read, newest first{cursor ? "; older ones are available" : "; that is all GitHub lists"}.
            {searched ? ` Matched against local arrivals #${searched.from} to #${searched.to}.` : matching ? " Matching local arrivals…" : ""}</p>
          {attempts.length ? (
            <ul aria-label="Delivery attempts" className="flex flex-col gap-1.5">
              {attempts.map((attempt) => {
                const sequence = matches[attempt.guid], held = pendingFor(attempt);
                return (
                  <li key={attempt.id} data-attempt={attempt.id} className="flex flex-col gap-0.5 rounded-lg border bg-background/60 px-2 py-1.5 text-[0.7rem]">
                    <div className="flex items-baseline gap-2">
                      <Word tone={attemptOk(attempt) ? "success" : "destructive"} className="text-[0.72rem]">{attempt.statusCode} {attempt.status}</Word>
                      <span className="min-w-0 truncate font-mono font-medium" title={attemptName(attempt)}>{attemptName(attempt)}</span>
                      {attempt.redelivery ? <span className={sourceChip}>redelivery</span> : null}
                      <Stamp at={attempt.deliveredAt} className="ml-auto shrink-0 text-muted-foreground" />
                    </div>
                    <span className="flex min-w-0 items-center gap-1 text-muted-foreground">Attempt {attempt.id} · {attempt.duration.toLocaleString("en-US", { maximumFractionDigits: 2 })}s · GUID <code className="min-w-0 truncate font-mono" title={attempt.guid}>{attempt.guid}</code><CopyButton value={attempt.guid} label="delivery GUID" className="opacity-100" /></span>
                    <span>{sequence !== undefined
                      ? <>Arrived here as <NodeLink node={{ kind: "github-delivery", id: String(sequence) }} label={`delivery #${sequence}`} className="font-medium">#{sequence}</NodeLink> (matched by GUID).</>
                      : <span className="text-muted-foreground">{searched ? "No local arrival with this GUID in the part searched." : "Not matched with a local arrival yet."}</span>}</span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {redeliver.available ? (
                        <Button size="xs" variant="outline" disabled={!connected || requests.busy !== null || Boolean(held)} title={held ? "A redelivery of this attempt is unconfirmed; see the recorded requests" : undefined} onClick={() => onRedeliver(attempt)}><RedoIcon data-icon="inline-start" />Redeliver…</Button>
                      ) : null}
                      {held ? <span className="text-warning">A redelivery request is {held.status === "unknown" ? "unknown" : "unconfirmed"}: see Requests.</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <p className={sourceHint}>GitHub lists no delivery attempts for this hook.</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            {cursor ? <Button size="xs" variant="outline" disabled={!read.available || !connected || loading} onClick={() => void load(cursor)}>{loading ? <Spinner data-icon="inline-start" /> : null}Read older attempts</Button> : null}
            {searched && searched.from > 1 ? <Button size="xs" variant="ghost" disabled={matching} onClick={further}>Look further back locally</Button> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
