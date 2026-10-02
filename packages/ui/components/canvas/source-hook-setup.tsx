"use client";

import { useState } from "react";
import { ClipboardCheckIcon, ListIcon, LogInIcon, SendIcon, XIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { entryWords, errorWords, eventSelection, orderHooks, planBlock, planReview, expiryWords, receiverName, type JournalEntry, type PlanReview } from "@/lib/stack/source-setup";
import { localOperation, localOperations } from "@/lib/stack/state";
import type { GithubAuthStatus, GithubEndpoint, GithubHook, GithubHookPlan, GithubSetup } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { CopyButton } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import type { RemoteRequests } from "./source-requests";
import { sourceChip, sourceHint, sourceLabel, Word } from "./source-shared";

/** A provider or owner failure in words. Only the sanitized code is ever shown; provider text never reaches the UI. */
export function codeWords(error: unknown): string {
  const text = errorMessage(error);
  const code = /(github_[a-z0-9_]+)/.exec(text)?.[1];
  return code ? errorWords(code) ?? text : text;
}

export const blockerWords: Record<string, string> = {
  receiver_disabled: "The receiver is disabled, so new requests are rejected. Enable it first.",
  public_https_origin_unset: "No public HTTPS origin is set, so GitHub's cloud has nowhere to send requests. Set the origin first.",
};

/**
 * Automated setup for a github.com repository or organization hook, one explicit step at a time: gh sign-in, the hooks at GitHub, a plan,
 * its review, then apply. Reading never changes GitHub. Applying records its request ID in this browser before it is sent, and a lost
 * answer is resolved by reading that ID's receipt, never by sending again.
 */
export function HookSetup({ endpoint, setup, requests }: { endpoint: GithubEndpoint; setup: GithubSetup | null; requests: RemoteRequests }) {
  const store = useStore();
  const state = useStack();
  const connected = state.status.source === "open";
  const authAccess = localOperation(state, "source", "github_auth_status");
  const listAccess = localOperation(state, "source", "github_hook_list");
  const applyAccess = localOperations(state, "source", ["github_hook_plan", "github_hook_apply", "github_remote_receipt_get"]);
  const [auth, setAuth] = useState<{ status: GithubAuthStatus } | { error: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [hooks, setHooks] = useState<GithubHook[] | null>(null);
  const [hooksError, setHooksError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [mode, setMode] = useState<"all" | "list">("all");
  const [eventsText, setEventsText] = useState("");
  const [plan, setPlan] = useState<GithubHookPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const blockers = setup?.blockers ?? [];
  const selection = eventSelection(mode, eventsText);

  const check = async () => {
    setChecking(true);
    try { setAuth({ status: await store.call<GithubAuthStatus>("source", "github_auth_status") }); } catch (error) { setAuth({ error: codeWords(error) }); } finally { setChecking(false); }
  };
  const readHooks = async () => {
    setReading(true); setHooksError(null);
    try { setHooks((await store.call<{ hooks: GithubHook[] }>("source", "github_hook_list", { endpointId: endpoint.id })).hooks); } catch (error) { setHooksError(codeWords(error)); } finally { setReading(false); }
  };
  const prepare = async () => {
    if (!selection.ok) return;
    setPlanning(true); setPlanError(null); setApplied(null);
    try { setPlan(await store.call<GithubHookPlan>("source", "github_hook_plan", { endpointId: endpoint.id, events: selection.events })); } catch (error) { setPlanError(codeWords(error)); } finally { setPlanning(false); }
  };
  const apply = async (review: PlanReview) => {
    const entry: JournalEntry = { requestId: crypto.randomUUID(), endpointId: endpoint.id, kind: "apply", at: Date.now(), status: "pending", planId: review.planId,
      hookId: review.hookId ?? undefined, startedAt: null, completedAt: null, error: null,
      intent: `${review.headline} for ${receiverName(endpoint)}: ${review.eventsWords}, to ${review.url}` };
    const outcome = await requests.send(entry);
    setConfirming(false);
    // The plan is spent once a request has gone out, whatever came back: a change of mind is a new plan, and a retry is the recorded request's own.
    setPlan(null);
    setApplied(outcome.sent ? entryWords(outcome.entry).text : outcome.reason);
  };

  return (
    <section aria-label="Automated hook setup" className="flex flex-col gap-3">
      <p className={sourceHint}>This is a github.com {endpoint.target.kind} receiver, so Stack can configure its hook through the <code className="font-mono">gh</code> command&rsquo;s existing sign-in. Each step below is yours to start; nothing runs on its own, and Stack never signs in for you.</p>

      <div className="flex flex-col gap-1.5">
        <span className={sourceLabel}>1 · gh sign-in</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={!authAccess.available || !connected || checking} title={authAccess.available ? undefined : authAccess.reason} onClick={() => void check()}>
            {checking ? <Spinner data-icon="inline-start" /> : <LogInIcon data-icon="inline-start" />}Check gh sign-in
          </Button>
        </div>
        {auth ? <AuthResult auth={auth} /> : <p className={sourceHint}>Reads the signed-in user once. It reports the login and a sanitized error; it never returns credentials.</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={sourceLabel}>2 · Hooks at GitHub</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={!listAccess.available || !connected || reading} title={listAccess.available ? undefined : listAccess.reason} onClick={() => void readHooks()}>
            {reading ? <Spinner data-icon="inline-start" /> : <ListIcon data-icon="inline-start" />}{hooks ? "Read hooks again" : "Read hooks"}
          </Button>
        </div>
        {hooksError ? <p role="alert" className="text-[0.72rem] text-destructive">{hooksError}</p> : null}
        {hooks ? <HookList hooks={hooks} endpoint={endpoint} /> : <p className={sourceHint}>Lists the hooks GitHub reports for this {endpoint.target.kind}, without their secrets. Reading changes nothing.</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={sourceLabel}>3 · Plan</span>
        {blockers.length ? <ul aria-label="Blocked until" className="flex flex-col gap-0.5 text-[0.72rem] text-warning">{blockers.map((blocker) => <li key={blocker}>{blockerWords[blocker] ?? blocker}</li>)}</ul> : null}
        {!plan ? (
          <>
            <fieldset className="flex flex-col gap-1.5 rounded-lg border p-2.5" disabled={planning}>
              <legend className={`${sourceLabel} px-1`}>Events</legend>
              <label className="flex items-start gap-1.5 text-[0.76rem]"><input type="radio" name={`events-${endpoint.id}`} checked={mode === "all"} onChange={() => setMode("all")} className="mt-0.5" />
                <span><span className="font-medium">All events (default)</span><span className="block text-[0.7rem] text-muted-foreground">Sends <code className="font-mono">*</code>. Stack keeps every delivery; a watch narrows what you read.</span></span></label>
              <label className="flex items-start gap-1.5 text-[0.76rem]"><input type="radio" name={`events-${endpoint.id}`} checked={mode === "list"} onChange={() => setMode("list")} className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-1"><span className="font-medium">Only these events</span>
                  {mode === "list" ? <Input aria-label="Hook events" value={eventsText} onChange={(event) => setEventsText(event.target.value)} placeholder="issues, pull_request" autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" /> : null}</span></label>
              {!selection.ok && mode === "list" && eventsText.trim() ? <p role="alert" className="text-[0.7rem] text-destructive">{selection.error}</p> : null}
            </fieldset>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="xs" disabled={!applyAccess.available || !connected || planning || !hooks || blockers.length > 0 || !selection.ok} title={!applyAccess.available ? applyAccess.reason : !hooks ? "Read the hooks at GitHub first" : undefined} onClick={() => void prepare()}>
                {planning ? <Spinner data-icon="inline-start" /> : <ClipboardCheckIcon data-icon="inline-start" />}Prepare plan
              </Button>
              <span className="text-[0.68rem] text-muted-foreground">{hooks ? "Nothing changes at GitHub until you apply the reviewed plan." : "Read the hooks first so the plan is reviewed against what is there."}</span>
            </div>
          </>
        ) : <PlanCard plan={plan} hooks={hooks} endpoint={endpoint} busy={requests.busy !== null} onApply={() => setConfirming(true)} onDiscard={() => { setPlan(null); setPlanError(null); }} />}
        {planError ? <p role="alert" className="text-[0.72rem] text-destructive">{planError}</p> : null}
        {applied ? <p role="status" className="rounded-lg border bg-muted/40 px-2.5 py-1.5 text-[0.72rem] text-pretty">{applied}</p> : null}
      </div>

      {plan ? <ConfirmApply plan={plan} hooks={hooks} endpoint={endpoint} open={confirming} pending={requests.busy !== null} onCancel={() => setConfirming(false)} onConfirm={(review) => void apply(review)} /> : null}
    </section>
  );
}

function AuthResult({ auth }: { auth: { status: GithubAuthStatus } | { error: string } }) {
  if ("error" in auth) return <p role="alert" className="text-[0.72rem] text-destructive">{auth.error}</p>;
  const { status } = auth;
  if (status.authenticated) {
    return (
      <div role="status" className="flex flex-col gap-0.5 text-[0.72rem]">
        <Word tone="success">Signed in as {status.login}</Word>
        <span className={sourceHint}>This is gh&rsquo;s own sign-in. It is not proof this account may administer these hooks: GitHub decides that when you read or apply.</span>
      </div>
    );
  }
  return (
    <div role="status" className="flex flex-col gap-0.5 text-[0.72rem]">
      <Word tone="warning">{status.available ? "gh is not signed in" : "gh is not available"}</Word>
      {status.error ? <span className="text-muted-foreground">{errorWords(status.error)}</span> : null}
      <span className={sourceHint}>{status.available ? "Sign in on this machine with `gh auth login`, then check again. Stack never signs in or stores credentials." : "Install the GitHub CLI on this machine, sign in, then check again."}</span>
    </div>
  );
}

function HookList({ hooks, endpoint }: { hooks: GithubHook[]; endpoint: GithubEndpoint }) {
  const rows = orderHooks(hooks, endpoint);
  const roleWord = { managed: "Managed by Stack", matching: "Matches this URL", other: "Not touched" } as const;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[0.72rem] text-muted-foreground">{hooks.length} {hooks.length === 1 ? "hook" : "hooks"} reported. Only the managed or URL-matching one can be changed; the others are never modified.</p>
      {rows.length ? (
        <ul aria-label="Hooks at GitHub" className="flex flex-col gap-1">
          {rows.map(({ hook, role }) => (
            <li key={hook.id} data-hook={hook.id} className="flex flex-col gap-0.5 rounded-lg border bg-background/60 px-2 py-1.5 text-[0.7rem]">
              <div className="flex items-baseline gap-2"><span className="font-mono font-medium">#{hook.id}</span><span className={sourceChip}>{hook.active ? "active" : "inactive"}</span>
                <span className={`${sourceChip} ml-auto`}>{roleWord[role]}</span></div>
              <span className="min-w-0 truncate font-mono text-[0.66rem]" title={hook.url}>{hook.url}</span>
              <span className="text-muted-foreground">Events: {hook.events.join(", ") || "none"} · {hook.contentType ?? "content type unset"} · TLS verification {hook.insecureSsl === "0" ? "on" : hook.insecureSsl === "1" ? "off" : "unset"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The bespoke plan review: exactly which hook, what it changes, what stays untouched, and until when this plan can be applied. */
function PlanCard({ plan, hooks, endpoint, busy, onApply, onDiscard }: { plan: GithubHookPlan; hooks: GithubHook[] | null; endpoint: GithubEndpoint; busy: boolean; onApply(): void; onDiscard(): void }) {
  const now = useNow(1000);
  const review = planReview(plan, hooks, endpoint, now);
  const block = planBlock(review);
  return (
    <section aria-label="Plan review" data-plan={plan.id} className="flex flex-col gap-2 rounded-lg border bg-background/60 p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[0.82rem] font-semibold">{review.headline}</span>
        <span className={`${sourceChip} ml-auto`} role="timer" aria-label="Plan expiry">{expiryWords(review.msLeft)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.72rem]">
        <dt className="text-muted-foreground">Receiver</dt><dd className="min-w-0 break-words">{receiverName(endpoint)}</dd>
        <dt className="text-muted-foreground">Hook</dt><dd>{review.action === "create" ? "A new hook will be created" : `Existing hook #${review.hookId}, matched by ${hooks?.find((hook) => hook.id === review.hookId)?.id === endpoint.managedHookId ? "Stack's record" : "its URL"}`}</dd>
        <dt className="text-muted-foreground">Webhook URL</dt><dd className="flex min-w-0 items-center gap-1"><span className="min-w-0 truncate font-mono text-[0.68rem]" title={review.url}>{review.url}</span><CopyButton value={review.url} label="webhook URL" className="opacity-100" /></dd>
        <dt className="text-muted-foreground">Events</dt><dd className="min-w-0 break-words font-mono text-[0.7rem]">{review.eventsWords}</dd>
        <dt className="text-muted-foreground">Delivery</dt><dd>JSON, TLS verification on, active</dd>
        <dt className="text-muted-foreground">Secret</dt><dd>The receiver&rsquo;s current secret, sent to gh privately. It is never shown here.</dd>
        <dt className="text-muted-foreground">Other hooks</dt><dd>{review.unrelated === null ? "Not read, so not counted." : `${review.unrelated} other ${review.unrelated === 1 ? "hook stays" : "hooks stay"} untouched.`}</dd>
      </dl>
      {review.action === "update" ? (
        review.current ? (
          review.changes.length ? (
            <ul aria-label="Changes to the hook" className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-2 py-1.5 text-[0.7rem]">
              {review.changes.map((change) => <li key={change.label} className="min-w-0 break-words"><span className="font-medium">{change.label}</span> <span className="text-muted-foreground">{change.from}</span> → <span>{change.to}</span></li>)}
            </ul>
          ) : <p className={sourceHint}>The hook already has these settings; applying re-sends them and the current secret.</p>
        ) : <p className={sourceHint}>Hook #{review.hookId} was not in the inventory read here, so the changes cannot be listed. Read the hooks again.</p>
      ) : null}
      <ul aria-label="Consequences" className="flex flex-col gap-1 text-[0.7rem] text-muted-foreground">
        {review.consequences.map((line) => <li key={line} className="flex gap-1.5 text-pretty"><span aria-hidden>·</span><span>{line}</span></li>)}
        <li className="flex gap-1.5 text-pretty"><span aria-hidden>·</span><span>Applying is configuration, not verification: it does not show that anything arrives. Send a ping afterwards.</span></li>
      </ul>
      {block ? <p role="alert" className="text-[0.72rem] text-warning">{block}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" disabled={Boolean(block) || busy} onClick={onApply}><SendIcon data-icon="inline-start" />Apply this plan…</Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onDiscard}><XIcon data-icon="inline-start" />Discard plan</Button>
        <span className="text-[0.68rem] text-muted-foreground">To change events, discard and prepare a new plan.</span>
      </div>
    </section>
  );
}

function ConfirmApply({ plan, hooks, endpoint, open, pending, onCancel, onConfirm }: { plan: GithubHookPlan; hooks: GithubHook[] | null; endpoint: GithubEndpoint; open: boolean; pending: boolean; onCancel(): void; onConfirm(review: PlanReview): void }) {
  const now = useNow(1000);
  const review = planReview(plan, hooks, endpoint, now);
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !pending) onCancel(); }}>
      <AlertDialogContent size="sm" aria-label="Confirm hook apply">
        <AlertDialogHeader>
          <AlertDialogMedia><SendIcon /></AlertDialogMedia>
          <AlertDialogTitle>{review.headline}?</AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-2">
            <span><span className="font-medium text-foreground">{endpoint.label}</span> at GitHub, events <code className="font-mono text-[0.68rem]">{review.eventsWords}</code>, URL <code className="font-mono text-[0.68rem] break-all">{review.url}</code>.</span>
            <span>This changes the hook at GitHub through gh. A request ID is recorded in this browser before it is sent. If the answer is lost, its receipt is read under that same ID; the request is never sent again under a new one.</span>
            <span>Success will mean GitHub accepted the configuration. It will not mean anything has arrived.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="group-data-[size=sm]/alert-dialog-content:grid-cols-1">
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={pending || Boolean(planBlock(review))} onClick={() => onConfirm(review)}>
            {pending ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}Apply to GitHub
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
