"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PlusIcon, SendIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { composeErrors, composeSchema, emptyCompose, notificationDraftKey, notificationInput, notificationSendAccess, readNotificationDraft, type ComposeField, type ComposeValues, type NotificationDraft, type NotificationKind } from "@/lib/stack/notify-compose";
import type { NotificationSend, OperationDoc } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { useNotifyActions } from "./notify-actions";
import { Empty, Row } from "./primitives";
import { waitingForIdentity } from "@/lib/stack/destination";
import { useDestination, useStack, useStore, useWorkbench } from "./provider";
import { Window } from "./window";

const labels = { title: "Title", message: "Message", subtitle: "Subtitle (optional)", source: "Source (optional)", group: "Group (optional)", open: "Open URL (optional)", reply: "Reply placeholder" };

/** Registration owns geometry; this body owns only the live form and its destination-pinned intent. */
export function ComposeWindow() {
  const state = useStack();
  const { local } = useDestination();
  const access = notificationSendAccess(state);
  if (state.remote && (!access.exposed || access.reason)) return null;
  const endpoint = state.endpoints.notify;
  return <Window id="notify-compose" title="Compose" subtitle="operator send" icon={SendIcon} accent="notify">
    {!endpoint || !access.operation || !access.exposed ? <Empty icon={SendIcon} title={access.reason ?? "Notify isn’t served by this server"} />
      : <ComposeForm key={endpoint} endpoint={endpoint} operation={access.operation} unavailable={access.reason ?? (state.status.notify !== "open" ? "The notify connection is not open. Your draft is retained." : !local ? `${waitingForIdentity} Drafts are kept per server.` : null)} />}
  </Window>;
}

function ComposeForm({ endpoint, operation, unavailable }: { endpoint: string; operation: OperationDoc; unavailable: string | null }) {
  const store = useStore();
  const actions = useNotifyActions();
  const { goTo } = useWorkbench();
  const state = useStack();
  const formId = useId();
  const [draft, setDraft] = useState<NotificationDraft | null>(null);
  const current = useRef<NotificationDraft | null>(null);
  const key = useRef<string | null>(null);
  const savedRaw = useRef<string | null>(null);
  const pending = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [validated, setValidated] = useState(false);
  const fields = operation.inputSchema.properties ?? {};
  const values = draft?.values ?? emptyCompose();
  const locked = busy || Boolean(draft?.input) || Boolean(recoveryError);
  const input = draft?.input ?? notificationInput(draft?.id ?? "", values, operation.inputSchema);
  const errors = composeErrors(input, values.kind, operation.inputSchema);
  const record = draft?.sent ? state.notificationRecords[draft.id] : undefined;

  // The draft belongs to this destination: its storage holds it, and until the server has named itself there is none,
  // so the form stays unready and nothing is read, written or sent.
  const { local: storage } = useDestination();
  useEffect(() => {
    if (!storage) return;
    key.current = notificationDraftKey(endpoint);
    const restore = () => {
      if (pending.current) return;
      try {
        const raw = storage.getItem(key.current!);
        savedRaw.current = raw;
        const saved = readNotificationDraft(raw);
        current.current = saved; setDraft(saved); setRecoveryError(null); setError(null);
      } catch (error) { setRecoveryError(errorMessage(error)); }
      setReady(true);
    };
    restore();
    const changed = (event: StorageEvent) => { if (event.key === storage.prefix + key.current || event.key === null) restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [endpoint, storage]);
  useEffect(() => draft?.sent ? store.watchNotification(draft.id) : undefined, [store, draft?.sent, draft?.id]);

  const hold = (next: NotificationDraft | null) => { current.current = next; setDraft(next); };
  const persist = (next: NotificationDraft | null) => {
    if (!key.current || !storage) throw new Error("The draft destination is not ready.");
    // Never overwrite a newer tab's intent, including when our acknowledgement arrives late.
    if (storage.getItem(key.current) !== savedRaw.current) throw new Error("The saved draft changed in another tab. Reload Compose before continuing.");
    const raw = next ? JSON.stringify(next) : null;
    if (raw) storage.setItem(key.current, raw);
    else storage.removeItem(key.current);
    savedRaw.current = raw;
  };
  const edit = (change: Partial<ComposeValues>) => {
    // Also enforce this outside DOM disabled state: unknown intent is never editable.
    if (!ready || pending.current || current.current?.input || recoveryError) return;
    const next: NotificationDraft = { version: 1, id: current.current?.id ?? crypto.randomUUID(), values: { ...(current.current?.values ?? emptyCompose()), ...change }, input: null, sent: false };
    hold(next); setError(null);
    try { persist(next); } catch { setError("Could not save this draft locally. Sending requires local draft storage."); }
  };
  const send = async () => {
    const held = current.current;
    if (!ready || !held || pending.current || held.sent || unavailable || recoveryError) return;
    setValidated(true);
    const exact = held.input ?? notificationInput(held.id, held.values, operation.inputSchema);
    if (Object.keys(composeErrors(exact, held.values.kind, operation.inputSchema)).length) return;
    const frozen: NotificationDraft = { ...held, input: exact };
    try {
      // Persist uncertainty BEFORE dispatch, including the exact payload; reload never silently re-arms it.
      persist(frozen);
    } catch (error) { setError(errorMessage(error)); return; }
    hold(frozen); pending.current = true; setBusy(true); setError(null);
    try {
      const result = await store.notify<NotificationSend>("notification_send", { ...exact });
      const sent: NotificationDraft = { ...frozen, sent: true };
      hold(sent);
      try { persist(sent); } catch { setError("Sent — stored, but the local receipt could not be saved. Reload to inspect the retained draft; this send’s ID stays unchanged."); }
      actions.open(result.id);
      goTo({ kind: "notification", id: result.id });
    } catch (error) {
      // Even a refusal is kept conservatively: no error string proves that mutation was absent.
      setError(errorMessage(error));
    } finally { pending.current = false; setBusy(false); }
  };
  const discard = () => {
    if (pending.current) return;
    try {
      persist(null); hold(null); setRecoveryError(null); setError(null); setValidated(false); setDiscarding(false);
    } catch { setError("Could not discard the saved draft, or it changed in another tab. Reload to inspect it. Nothing has been changed or resent."); }
  };
  const control = (name: keyof typeof labels) => {
    const rule = composeSchema(fields[name]);
    if (!rule) return null;
    const id = `${formId}-${name}`;
    const invalid = validated ? errors[name] : undefined;
    const props = { id, value: values[name], disabled: locked || !ready, maxLength: typeof rule.maxLength === "number" ? rule.maxLength : undefined, "aria-invalid": Boolean(invalid), "aria-describedby": name === "group" ? `${id}-hint` : invalid ? `${id}-error` : undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => edit({ [name]: event.target.value }) };
    return <Field key={name} data-invalid={Boolean(invalid)} data-disabled={locked}>
      <FieldLabel htmlFor={id}>{labels[name]}</FieldLabel>
      {name === "message" ? <Textarea {...props} rows={4} /> : <Input {...props} type={name === "open" ? "url" : "text"} autoComplete="off" />}
      {name === "group" ? <FieldDescription id={`${id}-hint`}>Sending with this group replaces its open predecessor. Replacement closes it without an answer; it is never approval.</FieldDescription> : null}
      {invalid ? <FieldError id={`${id}-error`}>{invalid}</FieldError> : null}
    </Field>;
  };
  const maxActions = typeof fields.actions?.maxItems === "number" ? fields.actions.maxItems : 0;
  const actionRule = composeSchema(fields.actions?.items);
  const chooseKind = (kind: NotificationKind) => edit({ kind, ...(kind === "question" && !values.actions.length ? { actions: [""] } : {}) });

  return <>
    {draft?.sent ? <Alert role="status"><AlertTitle>Sent — stored</AlertTitle><AlertDescription>{record ? `“${record.contentClearedAt ? "Content cleared" : record.title}” is stored in Inbox.` : "The send acknowledgement confirmed storage."} This is not an answer or approval.</AlertDescription></Alert>
      : draft?.input && !busy ? <Alert><AlertTitle>Send outcome uncertain</AlertTitle><AlertDescription>Retry sends the same ID and identical input. To change intent, explicitly discard this uncertain draft first. Discarding cannot recall a notification already stored.</AlertDescription></Alert> : null}
    {recoveryError || error ? <Alert variant="destructive"><AlertDescription>{recoveryError ?? error}</AlertDescription></Alert> : null}
    {unavailable ? <p role="status" className="text-xs text-muted-foreground">{unavailable}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <FieldGroup>
        {control("title")}{control("message")}
        <Field>
          <FieldLabel id={`${formId}-kind`}>Kind</FieldLabel>
          <ToggleGroup aria-labelledby={`${formId}-kind`} value={[values.kind]} onValueChange={(next) => { if (next.length) chooseKind(next[0] as NotificationKind); }} disabled={locked || !ready} size="sm" variant="outline" spacing={0}>
            <ToggleGroupItem value="notice">Notice</ToggleGroupItem>
            {fields.actions && maxActions > 0 ? <ToggleGroupItem value="question">Question</ToggleGroupItem> : null}
            {fields.reply ? <ToggleGroupItem value="reply">Reply prompt</ToggleGroupItem> : null}
          </ToggleGroup>
          <FieldDescription>{values.kind === "notice" ? "A notice offers no answer buttons or reply." : values.kind === "question" ? `Offer up to ${maxActions} explicit answer choices.` : "Offer a free-text reply, with a placeholder."}</FieldDescription>
        </Field>
        {values.kind === "question" && fields.actions ? <Field data-invalid={validated && Boolean(errors.actions)}>
          {values.actions.map((label, index) => <div key={index} className="flex items-end gap-2">
            <Field className="min-w-0 flex-1"><FieldLabel htmlFor={`${formId}-action-${index}`}>Choice {index + 1}</FieldLabel>
              <Input id={`${formId}-action-${index}`} value={label} disabled={locked || !ready} maxLength={typeof actionRule?.maxLength === "number" ? actionRule.maxLength : undefined} aria-invalid={validated && Boolean(errors.actions)} aria-describedby={validated && errors.actions ? `${formId}-actions-error` : undefined}
                onChange={(event) => edit({ actions: values.actions.map((value, at) => at === index ? event.target.value : value) })} /></Field>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove choice ${index + 1}`} disabled={locked || !ready} onClick={() => edit({ actions: values.actions.filter((_, at) => at !== index) })}><XIcon /></Button>
          </div>)}
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={locked || !ready || values.actions.length >= maxActions} onClick={() => edit({ actions: [...values.actions, ""] })}><PlusIcon data-icon="inline-start" />Add choice</Button>
          {validated && errors.actions ? <FieldError id={`${formId}-actions-error`}>{errors.actions}</FieldError> : null}
        </Field> : null}
        {values.kind === "reply" ? control("reply") : null}
        {control("subtitle")}{control("source")}{control("group")}{control("open")}
        <p className="text-xs text-muted-foreground">No Bot watch (operator send). Only an actual action choice or reply is an answer. Closing, opening, replacing, read state and silence are never approval.</p>
        <div className="flex flex-wrap items-center gap-2">
          {!draft?.sent ? <Button type="submit" size="sm" disabled={!ready || busy || !draft || Boolean(unavailable) || Boolean(recoveryError)}>{busy ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}{busy ? "Sending…" : draft?.input ? "Retry identical send" : "Send notification"}</Button> : <Button type="button" size="sm" variant="outline" onClick={() => { actions.open(draft.id); goTo({ kind: "notification", id: draft.id }); }}>Show notification</Button>}
          {draft || recoveryError ? <Button type="button" size="sm" variant="ghost" disabled={busy || !ready} onClick={() => draft?.sent ? discard() : setDiscarding(true)}>{draft?.sent ? "New notification" : "Discard draft…"}</Button> : null}
        </div>
      </FieldGroup>
    </form>
    {draft ? <Row label="Draft ID" mono copy={draft.id}>{draft.id}</Row> : null}
    <AlertDialog open={discarding} onOpenChange={setDiscarding}>
      <AlertDialogContent size="sm"><AlertDialogHeader><AlertDialogTitle>{draft?.input || recoveryError ? "Discard uncertain draft?" : "Discard notification draft?"}</AlertDialogTitle>
        <AlertDialogDescription>{draft?.input || recoveryError ? "The notification may already be stored. Discarding removes only this local retry intent; it does not recall, dismiss or answer that notification. The next edit gets a new ID." : "This removes the local draft. The next edit gets a new ID."}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep draft</AlertDialogCancel><Button variant="destructive" onClick={discard}>Discard draft</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
