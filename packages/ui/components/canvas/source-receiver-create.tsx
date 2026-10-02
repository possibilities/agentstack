"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, LogInIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { targetKinds, targetLabel } from "@/lib/stack/source";
import {
  createOutcome, destinationKeyValue, createSlot, emptyReceiverDraft, emptyTargetDraft, errorWords, freezeReceiver, maxReceiverLabel, setupMode, targetKindList,
  type CreateRecord, type FrozenReceiver, type KeyValue, type ReceiverCreateInput, type ReceiverDraft,
} from "@/lib/stack/source-setup";
import { localOperation } from "@/lib/stack/state";
import type { GithubAuthStatus, GithubEndpoint, GithubOrganizationEntry, GithubRepositoryEntry } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { CopyButton } from "./primitives";
import { notRecorded, waitingForIdentity } from "@/lib/stack/destination";
import { useDestination, useStack, useStore, useWorkbench } from "./provider";
import { fieldLabel } from "./scrape-shared";
import { codeWords } from "./source-hook-setup";
import { sourceHint, sourceLabel, Word } from "./source-shared";

/** The unconfirmed creation this destination's storage recorded before sending it, if any. */
export function readCreateRecord(journal: KeyValue): CreateRecord | null {
  try {
    const value: unknown = JSON.parse(journal.get(createSlot) ?? "null");
    const input = (value as CreateRecord | null)?.input;
    return input && typeof input.id === "string" && typeof input.label === "string" && input.target && typeof input.githubHost === "string" ? value as CreateRecord : null;
  } catch { return null; }
}
export const clearCreateRecord = (journal: KeyValue): void => journal.remove(createSlot);

type Step =
  | { name: "edit" }
  | { name: "review"; frozen: FrozenReceiver; notes: string[] }
  | { name: "saving"; frozen: FrozenReceiver }
  /** The owner's answer was not a clear success. `confirmed` is what reading the receiver back by ID said. */
  | { name: "failed"; frozen: FrozenReceiver; error: string | null; confirmed: "created" | "absent" | "mismatch" | "unknown" }
  | { name: "saved"; endpoint: GithubEndpoint };

const draftOf = (input: ReceiverCreateInput): ReceiverDraft => ({
  id: input.id, label: input.label, githubHost: input.githubHost, publicOrigin: input.publicOrigin ?? "",
  target: { ...emptyTargetDraft, kind: input.target.kind,
    repository: input.target.kind === "repository" ? input.target.repository : "", organization: input.target.kind === "organization" ? input.target.organization : "",
    enterprise: input.target.kind === "enterprise" ? input.target.enterprise : "", account: input.target.kind === "sponsors_listing" ? input.target.account : "",
    appId: input.target.kind === "app" && input.target.appId ? String(input.target.appId) : "" },
});

/**
 * Create a receiver: an immutable target, frozen and shown whole before it is sent. The receiver's UUID is recorded in this browser before
 * the request goes out, so an answer that is lost is read back by that ID. Saving is local configuration only: nothing is configured at
 * GitHub and nothing is published.
 */
export function CreateReceiver({ resume, count, onClose }: { resume: CreateRecord | null; count: number; onClose(): void }) {
  const store = useStore();
  const state = useStack();
  const { goTo } = useWorkbench();
  const { local } = useDestination();
  const journal = useMemo(() => destinationKeyValue(local), [local]);
  const [draft, setDraft] = useState<ReceiverDraft>(() => resume ? draftOf(resume.input) : emptyReceiverDraft(crypto.randomUUID()));
  const [errors, setErrors] = useState<string[]>([]);
  const [step, setStep] = useState<Step>({ name: "edit" });
  const [picker, setPicker] = useState(false);
  const mode = setupMode({ kind: draft.target.kind }, draft.githubHost || "github.com");
  const connected = state.status.source === "open";

  /** Read a receiver back by ID: the answer to a creation whose outcome is not known. */
  const readBack = async (frozen: FrozenReceiver, error: string | null) => {
    let confirmed: "created" | "absent" | "mismatch" | "unknown" = "unknown";
    let found: GithubEndpoint | null = null;
    try { found = await store.readSourceReceiver(frozen.input.id); confirmed = createOutcome(found, frozen.input); } catch (readError) {
      if (/github_endpoint_not_found/.test(errorMessage(readError))) confirmed = "absent";
    }
    if (confirmed === "created" && found) { clearCreateRecord(journal); void store.loadSourceSetup(found.id); setStep({ name: "saved", endpoint: found }); return; }
    setStep({ name: "failed", frozen, error, confirmed });
  };
  // Reopened after a reload with an unconfirmed creation: say what the owner holds before anything is sent.
  useEffect(() => {
    if (!resume) return;
    const result = freezeReceiver(draftOf(resume.input), null);
    if (result.ok) { setStep({ name: "saving", frozen: result.frozen }); void readBack(result.frozen, null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const review = () => {
    const result = freezeReceiver(draft, count);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors([]);
    setStep({ name: "review", frozen: result.frozen, notes: result.notes });
  };
  /** Record the exact request, then send it. If it cannot be recorded it is not sent. */
  const save = async (frozen: FrozenReceiver) => {
    const record: CreateRecord = { input: { ...frozen.input }, at: Date.now() };
    if (!journal.set(createSlot, JSON.stringify(record))) {
      setStep({ name: "failed", frozen, error: local ? notRecorded : waitingForIdentity, confirmed: "absent" });
      return;
    }
    setStep({ name: "saving", frozen });
    try {
      const endpoint = await store.createSourceReceiver({ ...frozen.input });
      clearCreateRecord(journal);
      void store.loadSourceSetup(endpoint.id);
      setStep({ name: "saved", endpoint });
    } catch (error) {
      const text = errorMessage(error);
      // A clear refusal wrote nothing; anything else may have, so the receiver is read back by its ID.
      if (/github_endpoint_id_conflict|github_endpoint_capacity/.test(text)) { clearCreateRecord(journal); setStep({ name: "failed", frozen, error: text, confirmed: /conflict/.test(text) ? "mismatch" : "absent" }); }
      else await readBack(frozen, text);
    }
  };
  const busy = step.name === "saving";
  const dismiss = () => { if (!busy) onClose(); };
  const abandon = () => { clearCreateRecord(journal); onClose(); };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md [&>*]:min-w-0" showCloseButton={!busy} aria-label="New receiver">
        <DialogHeader>
          <DialogTitle>{step.name === "saved" ? "Receiver saved locally" : "New receiver"}</DialogTitle>
          <DialogDescription>A receiver is one signed webhook source. Creating it saves Stack&rsquo;s local configuration and a private secret. It does not configure GitHub or publish anything.</DialogDescription>
        </DialogHeader>
        {step.name === "saved" ? <Saved endpoint={step.endpoint} onDone={onClose} onOpen={() => { goTo({ kind: "github-receiver", id: step.endpoint.id }); onClose(); }} />
          : step.name === "edit" ? (
            <form aria-label="New receiver form" className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); review(); }}>
              <div className="flex flex-col gap-1">
                <span className={fieldLabel}>Receiver ID</span>
                <span className="flex items-center gap-1.5"><code className="min-w-0 truncate font-mono text-[0.72rem]" title={draft.id}>{draft.id}</code><CopyButton value={draft.id} label="receiver ID" className="opacity-100" />
                  <Button type="button" size="xs" variant="ghost" onClick={() => setDraft({ ...draft, id: crypto.randomUUID() })}><RefreshCwIcon data-icon="inline-start" />New ID</Button></span>
                <span className={sourceHint}>Recorded in this browser before it is sent. Sending the same ID with the same definition returns the same receiver.</span>
              </div>
              <label className="flex flex-col gap-1"><span className={fieldLabel}>Label</span>
                <Input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} maxLength={maxReceiverLabel} placeholder="Product repository" autoComplete="off" className="h-7 text-[0.78rem]" /></label>
              <fieldset className="flex flex-col gap-2 rounded-lg border p-2.5">
                <legend className={`${sourceLabel} px-1`}>Target · cannot be changed later</legend>
                <label className="flex flex-col gap-1"><span className={fieldLabel}>Kind</span>
                  <NativeSelect size="sm" aria-label="Target kind" value={draft.target.kind} onChange={(event) => { setDraft({ ...draft, target: { ...draft.target, kind: event.target.value as ReceiverDraft["target"]["kind"] } }); setPicker(false); }}>
                    {targetKindList.map((kind) => <NativeSelectOption key={kind} value={kind}>{targetKinds[kind]}</NativeSelectOption>)}
                  </NativeSelect></label>
                <TargetFields draft={draft} setDraft={setDraft} />
                {mode.automated ? (
                  <div className="flex flex-col gap-1">
                    <div><Button type="button" size="xs" variant="outline" disabled={!connected} onClick={() => setPicker(!picker)}>{picker ? "Close the gh picker" : `Pick a ${draft.target.kind} with gh…`}</Button></div>
                    {picker ? <GhPicker kind={draft.target.kind === "organization" ? "organization" : "repository"} onPick={(value) => { setDraft({ ...draft, target: draft.target.kind === "organization" ? { ...draft.target, organization: value } : { ...draft.target, repository: value } }); setPicker(false); }} /> : null}
                  </div>
                ) : <p className={sourceHint}>{mode.reason}</p>}
              </fieldset>
              <label className="flex flex-col gap-1"><span className={fieldLabel}>GitHub host</span>
                <Input value={draft.githubHost} onChange={(event) => { setDraft({ ...draft, githubHost: event.target.value }); }} placeholder="github.com" autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" />
                <span className={sourceHint}>Fixed once created. A host other than github.com is GitHub Enterprise Server: set up by hand, with no network call to it.</span></label>
              <label className="flex flex-col gap-1"><span className={fieldLabel}>Public origin (optional)</span>
                <Input value={draft.publicOrigin} onChange={(event) => setDraft({ ...draft, publicOrigin: event.target.value })} placeholder="https://hooks.example.com" autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" />
                <span className={sourceHint}>The externally reachable HTTPS origin, with no path. Leave empty to set it later. It is not a reachability test.</span></label>
              {errors.length ? <ul role="alert" className="flex flex-col gap-0.5 text-[0.72rem] text-destructive">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
              <div className="flex flex-wrap items-center gap-1.5">
                <Button type="submit" size="sm"><PlusIcon data-icon="inline-start" />Review receiver</Button>
                <span className="text-[0.68rem] text-muted-foreground">Nothing is saved until you confirm the review.</span>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-2.5">
              <p className={sourceHint}>Review the request as it will be sent.</p>
              <dl aria-label="Receiver to save" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.76rem]">
                <dt className="text-muted-foreground">Label</dt><dd className="min-w-0 break-words font-medium">{step.frozen.input.label}</dd>
                <dt className="text-muted-foreground">ID</dt><dd className="min-w-0 break-all font-mono text-[0.7rem]">{step.frozen.input.id}</dd>
                <dt className="text-muted-foreground">Target</dt><dd className="min-w-0 break-words"><span className="text-muted-foreground">{targetKinds[step.frozen.input.target.kind]} </span><span className="font-mono text-[0.72rem]">{targetLabel(step.frozen.input.target)}</span></dd>
                <dt className="text-muted-foreground">GitHub host</dt><dd className="font-mono text-[0.72rem]">{step.frozen.input.githubHost}</dd>
                <dt className="text-muted-foreground">Public origin</dt><dd className="min-w-0 break-all font-mono text-[0.72rem]">{step.frozen.input.publicOrigin ?? <span className="font-sans text-muted-foreground">not set</span>}</dd>
              </dl>
              <details className="rounded-lg border border-dashed">
                <summary className="cursor-pointer px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Exact request</summary>
                <pre aria-label="Exact github_endpoint_create request" className="max-h-48 overflow-auto border-t border-dashed p-2.5 font-mono text-[0.68rem] break-words whitespace-pre-wrap">{step.frozen.json}</pre>
              </details>
              {step.name === "review" && step.notes.length ? <ul aria-label="Cautions" className="flex flex-col gap-1 text-[0.72rem] text-warning">{step.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
              {step.name === "failed" ? <Failed step={step} /> : null}
              <div className="flex flex-wrap items-center gap-1.5">
                {step.name === "failed" && step.confirmed === "mismatch" ? (
                  <Button type="button" size="sm" onClick={() => { clearCreateRecord(journal); setDraft({ ...draftOf(step.frozen.input), id: crypto.randomUUID() }); setStep({ name: "edit" }); }}>Start again with a new ID</Button>
                ) : (
                  <Button type="button" size="sm" disabled={busy || !connected || !local} onClick={() => void save(step.frozen)}>
                    {busy ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}{step.name === "failed" ? "Save again (same ID)" : "Save receiver locally"}
                  </Button>
                )}
                {!local ? <span role="status" className="text-[0.72rem] text-muted-foreground">{waitingForIdentity}</span> : null}
                {step.name === "failed" ? <Button type="button" size="sm" variant="ghost" onClick={abandon}>Forget this attempt</Button> : null}
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setStep({ name: "edit" })}><ArrowLeftIcon data-icon="inline-start" />Back to edit</Button>
              </div>
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}

function TargetFields({ draft, setDraft }: { draft: ReceiverDraft; setDraft(next: ReceiverDraft): void }) {
  const set = (patch: Partial<ReceiverDraft["target"]>) => setDraft({ ...draft, target: { ...draft.target, ...patch } });
  const field = (label: string, key: "repository" | "organization" | "enterprise" | "account" | "appId", placeholder: string, hint: string) => (
    <label className="flex flex-col gap-1"><span className={fieldLabel}>{label}</span>
      <Input aria-label={label} value={draft.target[key]} onChange={(event) => set({ [key]: event.target.value })} placeholder={placeholder} autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" />
      <span className={sourceHint}>{hint}</span></label>
  );
  switch (draft.target.kind) {
    case "repository": return field("Repository", "repository", "owner/project", "The repository this webhook belongs to, as owner/name.");
    case "organization": return field("Organization", "organization", "acme", "The organization's login.");
    case "enterprise": return field("Enterprise", "enterprise", "acme-corp", "The enterprise slug. Configured by hand in GitHub's settings.");
    case "sponsors_listing": return field("Sponsors account", "account", "octocat", "The account with the Sponsors listing.");
    case "app": return field("App ID (optional)", "appId", "123456", "Leave empty to accept any installation of any App; an ID narrows it to one App.");
    case "marketplace": return <p className={sourceHint}>A Marketplace webhook has no further fields.</p>;
  }
}

function Failed({ step }: { step: Extract<Step, { name: "failed" }> }) {
  const headline = step.confirmed === "absent" ? "The receiver was not saved." : step.confirmed === "mismatch" ? "That ID belongs to a different receiver." : step.confirmed === "created" ? "The receiver exists." : "Result not confirmed.";
  const body = step.confirmed === "absent" ? "Reading it back by its ID shows it does not exist. Saving again sends the same reviewed request."
    : step.confirmed === "mismatch" ? "A receiver with this ID exists with a different target or host, so nothing was changed. Start again with a new ID."
    : "The receiver could not be read back, so it may or may not exist. Saving again with this ID and this exact definition is safe: it returns the existing receiver and never creates a second.";
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-2 text-[0.74rem]">
      <p><span className="font-semibold">{headline}</span>{step.error ? ` ${codeWords(step.error)}` : ""}</p>
      <p>{body}</p>
    </div>
  );
}

/** The result of a save, then what the owner's setup read says comes next. */
function Saved({ endpoint, onDone, onOpen }: { endpoint: GithubEndpoint; onDone(): void; onOpen(): void }) {
  const { sourceSetups } = useStack();
  const held = sourceSetups[endpoint.id];
  const setup = held?.data ?? null;
  return (
    <div className="flex flex-col gap-2.5">
      <p role="status" className="text-[0.76rem]"><span className="font-semibold">“{endpoint.label}” is saved locally.</span> Stack holds its configuration and a private secret. Nothing was configured at GitHub and nothing was published.</p>
      <dl aria-label="Setup read" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.72rem]">
        <dt className="text-muted-foreground">ID</dt><dd className="min-w-0 break-all font-mono text-[0.7rem]">{endpoint.id}</dd>
        <dt className="text-muted-foreground">Loopback destination</dt><dd className="min-w-0 break-all font-mono text-[0.7rem]">{setup?.ingress.localUrl ?? "reading…"}</dd>
        <dt className="text-muted-foreground">Webhook URL</dt><dd className="min-w-0 break-all font-mono text-[0.7rem]">{endpoint.webhookUrl ?? <span className="font-sans text-muted-foreground">none until a public origin is set</span>}</dd>
        <dt className="text-muted-foreground">Setup</dt><dd>{setup ? (setup.automatedHookManagement ? "Stack can configure this hook through gh, once you start each step." : "By hand: Stack gives the exact settings and the secret on request.") : "reading…"}</dd>
      </dl>
      {held?.error ? <p role="alert" className="text-[0.72rem] text-destructive">Setup read failed: {held.error}</p> : null}
      {setup?.blockers.length ? <ul aria-label="Blocked until" className="flex flex-col gap-0.5 text-[0.72rem] text-warning">{setup.blockers.map((blocker) => <li key={blocker}>{blocker === "public_https_origin_unset" ? "No public HTTPS origin is set: GitHub's cloud cannot reach this receiver until one is." : "The receiver is disabled."}</li>)}</ul> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={onOpen}>Open its setup</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/**
 * Pick a repository or organization from what gh can see. Asking is explicit: the sign-in is checked first, and a listing is observation only.
 * An admin flag is what GitHub reported for gh's account, not a promise that a hook can be configured.
 */
function GhPicker({ kind, onPick }: { kind: "repository" | "organization"; onPick(value: string): void }) {
  const store = useStore();
  const state = useStack();
  const auth = localOperation(state, "source", "github_auth_status");
  const listing = localOperation(state, "source", kind === "repository" ? "github_repositories" : "github_organizations");
  const [signedIn, setSignedIn] = useState<GithubAuthStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepositoryEntry[]>([]);
  const [orgs, setOrgs] = useState<GithubOrganizationEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [organization, setOrganization] = useState("");
  const [query, setQuery] = useState("");
  const [listed, setListed] = useState(false);
  const connected = state.status.source === "open";
  const check = async () => {
    setLoading(true); setError(null);
    try { setSignedIn(await store.call<GithubAuthStatus>("source", "github_auth_status")); } catch (failure) { setError(codeWords(failure)); } finally { setLoading(false); }
  };
  const load = async (page: number, reset: boolean) => {
    setLoading(true); setError(null);
    try {
      if (kind === "repository") {
        const result = await store.call<{ entries: GithubRepositoryEntry[]; nextPage: number | null }>("source", "github_repositories", { page, ...(organization.trim() ? { organization: organization.trim() } : {}) });
        setRepos((held) => reset ? result.entries : [...held, ...result.entries]); setNext(result.nextPage);
      } else {
        const result = await store.call<{ entries: GithubOrganizationEntry[]; nextPage: number | null }>("source", "github_organizations", { page });
        setOrgs((held) => reset ? result.entries : [...held, ...result.entries]); setNext(result.nextPage);
      }
      setListed(true);
    } catch (failure) { setError(codeWords(failure)); } finally { setLoading(false); }
  };
  const needle = query.trim().toLowerCase();
  const shownRepos = repos.filter((entry) => !needle || entry.repository.toLowerCase().includes(needle));
  const shownOrgs = orgs.filter((entry) => !needle || entry.login.toLowerCase().includes(needle));
  return (
    <section aria-label={`Pick a ${kind} with gh`} className="flex flex-col gap-2 rounded-lg border bg-background/60 p-2.5">
      <p className={sourceHint}>Lists what the <code className="font-mono">gh</code> command can see. It uses gh&rsquo;s existing sign-in, never signs in, and returns no credentials. Being listed, or having admin, is not proof you may configure a hook.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="xs" variant="outline" disabled={!auth.available || !connected || loading} title={auth.available ? undefined : auth.reason} onClick={() => void check()}>
          {loading && !signedIn ? <Spinner data-icon="inline-start" /> : <LogInIcon data-icon="inline-start" />}Check gh sign-in
        </Button>
        {signedIn?.authenticated ? <Word tone="success" className="text-[0.72rem]">Signed in as {signedIn.login}</Word> : signedIn ? <Word tone="warning" className="text-[0.72rem]">{signedIn.available ? "gh is not signed in" : "gh is not available"}</Word> : null}
      </div>
      {signedIn && !signedIn.authenticated ? (
        <p className={sourceHint}>{errorWords(signedIn.error) ? `${errorWords(signedIn.error)} ` : ""}{signedIn.available ? "Sign in on this machine with `gh auth login`, then check again." : "Install the GitHub CLI, sign in, then check again."}</p>
      ) : null}
      {signedIn?.authenticated ? (
        <>
          {kind === "repository" ? (
            <label className="flex flex-col gap-1"><span className={fieldLabel}>Only repositories of this organization (optional)</span>
              <Input aria-label="Organization to list repositories of" value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="acme" autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" /></label>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" disabled={!listing.available || !connected || loading} title={listing.available ? undefined : listing.reason} onClick={() => void load(1, true)}>
              {loading && signedIn ? <Spinner data-icon="inline-start" /> : null}{listed ? "List again" : kind === "repository" ? "List repositories" : "List organizations"}
            </Button>
          </div>
        </>
      ) : null}
      {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
      {listed ? (
        <>
          <Input aria-label="Filter the loaded list" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter what is loaded" autoComplete="off" className="h-7 text-[0.74rem]" />
          <ul aria-label={kind === "repository" ? "Repositories" : "Organizations"} className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {kind === "repository" ? shownRepos.map((entry) => (
              <li key={entry.id} className="flex min-w-0 items-center gap-2 text-[0.72rem]">
                <span className="min-w-0 flex-1 truncate font-mono" title={entry.repository}>{entry.repository}</span>
                <span className="shrink-0 text-[0.66rem] text-muted-foreground">{entry.private ? "private" : "public"}{entry.archived ? " · archived" : ""} · admin {entry.admin === null ? "unknown" : entry.admin ? "yes" : "no"}</span>
                <Button type="button" size="xs" variant="outline" onClick={() => onPick(entry.repository)}>Use</Button>
              </li>
            )) : shownOrgs.map((entry) => (
              <li key={entry.id} className="flex min-w-0 items-center gap-2 text-[0.72rem]">
                <span className="min-w-0 flex-1 truncate font-mono" title={entry.login}>{entry.login}</span>
                <Button type="button" size="xs" variant="outline" onClick={() => onPick(entry.login)}>Use</Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-1.5">
            {next !== null ? <Button type="button" size="xs" variant="outline" disabled={loading} onClick={() => void load(next, false)}>{loading ? <Spinner data-icon="inline-start" /> : null}Load more</Button> : <span className="text-[0.68rem] text-muted-foreground">That is everything gh listed.</span>}
            <span className="text-[0.68rem] text-muted-foreground tabular-nums">{kind === "repository" ? repos.length : orgs.length} loaded</span>
          </div>
        </>
      ) : null}
    </section>
  );
}
