"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { botControlOperations, botOperationDraft, connectedVoiceSession, inputKind, inputRequired, operationScopeError, parseOperationDraft } from "@/lib/stack/bot-operations";
import type { BotUploads } from "@/lib/stack/bot-uploads";
import { operationTitle } from "@/lib/stack/catalog";
import type { Bot, OperationDoc } from "@/lib/stack/types";
import { CopyButton } from "./primitives";
import { useStack, useStore } from "./provider";
import { RecordTree } from "./record-tree";

export function BotOperations({ bot, uploads, onPendingChange }: { bot: Bot; uploads: BotUploads; onPendingChange(pending: boolean): void }) {
  const { catalog } = useStack();
  const operations = catalog.data?.find((doc) => doc.name === "bots")?.operations.filter((operation) => !botControlOperations.has(operation.name)) ?? [];
  const [name, setName] = useState(bot.mainThreadId ? "chat_list" : "chat_open");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const pendingChanged = (value: boolean) => { pendingRef.current = value; setPending(value); onPendingChange(value); };
  const id = useId();
  const operation = operations.find((item) => item.name === name);
  return <div className="flex min-w-0 flex-col gap-4">
    <Field data-disabled={pending}><FieldLabel htmlFor={id}>Operation</FieldLabel><NativeSelect id={id} value={name} disabled={pending} onChange={(event) => { if (!pendingRef.current) setName(event.target.value); }}>
      {[true, false].map((read) => <NativeSelectOptGroup key={String(read)} label={read ? "Reads" : "Actions"}>{operations.filter((item) => (item.annotations.readOnlyHint === true) === read).map((item) => <NativeSelectOption key={item.name} value={item.name}>{operationTitle(item)} · {item.name}</NativeSelectOption>)}</NativeSelectOptGroup>)}
    </NativeSelect></Field>
    {operation ? <OperationForm key={`${bot.id}:${operation.name}`} bot={bot} operation={operation} onPendingChange={pendingChanged} /> : <p className="text-sm text-muted-foreground">{catalog.error ?? "Waiting for the Bots API discovery schema."}</p>}
    <details><summary className="cursor-pointer text-sm font-medium">Upload a file to this Bot</summary><div className="mt-3"><BotUpload botId={bot.id} uploads={uploads} /></div></details>
  </div>;
}

function OperationForm({ bot, operation, onPendingChange }: { bot: Bot; operation: OperationDoc; onPendingChange(pending: boolean): void }) {
  const { voice, status, botInvalidations } = useStack();
  const store = useStore();
  const [draft, setDraft] = useState(() => botOperationDraft(operation, bot, voice.data));
  const [result, setResult] = useState<{ value: unknown; input: Record<string, unknown>; generation: number; at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const id = useId();
  const fields = Object.entries(operation.inputSchema.properties ?? {});
  const read = operation.annotations.readOnlyHint === true;
  const stale = result && (botInvalidations[bot.id] ?? 0) > result.generation;
  const change = (key: string, value: string) => { if (!pendingRef.current) setDraft((current) => ({ ...current, [key]: value })); };
  const scopeError = operationScopeError(operation, draft, bot, voice.data);
  const unavailable = status.bots !== "open" || Boolean(scopeError);
  const wrongThread = !read && fields.some(([key]) => key === "threadId") && draft.threadId !== bot.mainThreadId;
  const voiceSession = connectedVoiceSession(bot, voice.data);
  const wrongCall = operation.name === "voice_speak" && (!voiceSession || draft.sessionId !== voiceSession);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (pendingRef.current || unavailable || wrongThread) return;
    setError(null);
    let input: Record<string, unknown>;
    const current = store.getState();
    try {
      input = parseOperationDraft(operation, draft, bot.id);
      const currentBot = current.bots.data?.find((item) => item.id === bot.id);
      if (!currentBot) throw new Error("This Bot is no longer present.");
      const issue = operationScopeError(operation, input, currentBot, current.voice.data);
      if (issue) throw new Error(issue);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    pendingRef.current = true;
    setPending(true);
    onPendingChange(true);
    try {
      const value = await store.call("bots", operation.name, input);
      setResult({ value, input, generation: current.botInvalidations[bot.id] ?? 0, at: new Date().toISOString() });
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : String(cause)}${read ? "" : ". An interrupted action may have taken effect. Inspect state before retrying."}`);
    } finally { pendingRef.current = false; setPending(false); onPendingChange(false); }
  }

  return <form onSubmit={(event) => void run(event)} className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap gap-2"><Badge variant="outline">{operation.name}</Badge><Badge variant={operation.annotations.destructiveHint === true ? "destructive" : "secondary"}>{read ? "Read only" : operation.annotations.destructiveHint === true ? "Destructive action" : "Action"}</Badge></div>
    <p className="text-sm text-muted-foreground">{operation.description}</p>
    <FieldGroup className="gap-4">
      {fields.map(([key, schema]) => {
        const required = inputRequired(operation, key);
        const kind = inputKind(schema);
        const controlId = `${id}-${key}`;
        const value = draft[key] ?? "";
        const locked = key === "botId" || (operation.name === "voice_speak" && key === "sessionId");
        const descriptionId = `${controlId}-description`;
        return <Field key={key} data-disabled={pending}>
          <FieldLabel htmlFor={controlId}>{key}{required ? "" : " (optional)"}</FieldLabel>
          {Array.isArray(schema.enum) || kind === "boolean" ? <NativeSelect id={controlId} value={value} required={required} disabled={pending || locked} aria-describedby={schema.description ? descriptionId : undefined} onChange={(event) => change(key, event.target.value)}>
            <NativeSelectOption value="">{required ? "Choose a value" : schema.default === undefined ? "Omit" : `Omit (default: ${String(schema.default)})`}</NativeSelectOption>
            {(schema.enum ?? [true, false]).map((item) => <NativeSelectOption key={String(item)} value={String(item)}>{String(item)}</NativeSelectOption>)}
          </NativeSelect> : ["array", "object", "json"].includes(kind) || key === "text" || key === "data" ? <Textarea id={controlId} value={value} required={required} disabled={pending} readOnly={locked} rows={4} aria-describedby={schema.description ? descriptionId : undefined} onChange={(event) => change(key, event.target.value)} placeholder={schema.default === undefined ? (kind === "string" ? "" : `${kind} as JSON`) : JSON.stringify(schema.default)} /> : <Input id={controlId} value={value} required={required} disabled={pending} readOnly={locked} aria-describedby={schema.description ? descriptionId : undefined} onChange={(event) => change(key, event.target.value)} placeholder={schema.default === undefined ? undefined : String(schema.default)} />}
          {schema.description ? <FieldDescription id={descriptionId}>{schema.description}</FieldDescription> : null}
        </Field>;
      })}
    </FieldGroup>
    {wrongThread ? <Alert><AlertDescription>Actions are limited to this Bot’s current main thread. Descendants are read-only.<Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => change("threadId", bot.mainThreadId ?? "")}>Use current main thread</Button></AlertDescription></Alert> : null}
    {wrongCall ? <Alert><AlertDescription>{voiceSession ? "The connected call changed. Bind this request to the current call before speaking." : "This Bot needs a connected voice call before speaking."}{voiceSession ? <Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => change("sessionId", voiceSession)}>Use current connected call</Button> : null}</AlertDescription></Alert> : null}
    {unavailable && !wrongThread && !wrongCall ? <p className="text-xs text-muted-foreground">{status.bots !== "open" ? "Waiting for the Bots connection." : scopeError}</p> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <Button type="submit" className="w-fit" variant={operation.annotations.destructiveHint === true ? "destructive" : "default"} disabled={pending || unavailable || wrongThread}>{pending ? <Spinner data-icon="inline-start" /> : null}{read ? "Read" : operationTitle(operation)}</Button>
    {result ? <section className="flex min-w-0 flex-col gap-3 border-t pt-4">
      <div className="flex items-center gap-2"><h3 className="text-sm font-medium">Result</h3><time className="text-xs text-muted-foreground" dateTime={result.at}>{result.at}</time><CopyButton value={JSON.stringify(result.value, null, 2)} label="operation result" className="ml-auto opacity-100" /></div>
      {stale ? <p className="text-xs text-muted-foreground">This snapshot may be out of date after a Bot notice or reconnection. Re-read the relevant operation.</p> : null}
      <div data-scroll className="max-h-96 overflow-y-auto overscroll-contain"><RecordTree value={result.value} /></div>
      <details><summary className="cursor-pointer text-xs">Raw JSON</summary><pre className="overflow-auto text-xs">{JSON.stringify(result.value, null, 2)}</pre></details>
      <details><summary className="cursor-pointer text-xs">Submitted input</summary><pre className="overflow-auto text-xs">{JSON.stringify(result.input, null, 2)}</pre></details>
    </section> : null}
  </form>;
}

/** An interrupted upload resumes only after an explicit click and an offset read. */
function BotUpload({ botId, uploads }: { botId: string; uploads: BotUploads }) {
  const { status } = useStack();
  const upload = useSyncExternalStore(uploads.subscribe, uploads.getState, uploads.getState)[botId];
  const { file, id: uploadId, receipt: result, error, pending = false } = upload ?? {};
  const id = useId();
  return <div className="flex flex-col gap-3">
    <Field data-disabled={pending}><FieldLabel htmlFor={id}>File (up to 20 MB)</FieldLabel><Input id={id} type="file" disabled={pending} onChange={(event) => { const file = event.target.files?.[0]; if (file) uploads.select(botId, file); }} /><FieldDescription>Use the verified path in a localImage, localAudio, or mention input. Uploading does not send a message. Upload state is retained while this page is open.</FieldDescription></Field>
    {file && uploadId ? <div className="flex flex-col gap-1 text-xs"><span>Selected: {file.name}</span><div className="flex items-center gap-2"><span>Upload ID</span><code className="break-all">{uploadId}</code><CopyButton value={uploadId} label="upload ID" className="opacity-100" /></div></div> : null}
    <Button type="button" size="sm" className="w-fit" variant="outline" disabled={!file || pending || Boolean(result?.path) || status.bots !== "open"} onClick={() => void uploads.run(botId)}>{pending ? <Spinner data-icon="inline-start" /> : null}{error ? "Resume upload" : "Upload file"}</Button>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {result ? <div className="flex flex-col gap-2 text-xs"><span>{result.offset.toLocaleString()} / {result.bytes.toLocaleString()} bytes</span>{result.path ? <div className="flex items-center gap-2"><code className="break-all">{result.path}</code><CopyButton value={result.path} label="verified upload path" className="opacity-100" /></div> : null}</div> : null}
  </div>;
}
