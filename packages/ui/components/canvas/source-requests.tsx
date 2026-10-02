"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { BookCheckIcon, SendIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  browserStorage, canReadReceipt, canSendAgain, entryWords, forget, journalVersion, onJournalChange, readJournal, remoteKindWords, resendArguments, sendRemote, recover,
  type JournalEntry, type RemoteIo, type RemoteOutcome,
} from "@/lib/stack/source-setup";
import type { GithubRemoteReceipt } from "@/lib/stack/types";
import { CopyButton } from "./primitives";
import { useStore } from "./provider";
import { Stamp, sourceHint, sourceLabel, Word } from "./source-shared";

const none: JournalEntry[] = [];
const held = new Map<string, { version: number; entries: JournalEntry[] }>();

/** This browser's recorded remote requests for one receiver. Re-renders when any is written. */
export function useJournal(endpointId: string): JournalEntry[] {
  const snapshot = useCallback(() => {
    const version = journalVersion(), cached = held.get(endpointId);
    if (cached && cached.version === version) return cached.entries;
    const entries = readJournal(browserStorage(), endpointId);
    held.set(endpointId, { version, entries });
    return entries;
  }, [endpointId]);
  return useSyncExternalStore(onJournalChange, snapshot, () => none);
}

/**
 * Send a hook request exactly as it is recorded: the arguments come from the journal entry, so what was reviewed and recorded is what goes
 * out, with its own request ID. A lost answer is resolved by reading that ID's receipt; nothing here dispatches a request twice.
 */
export function useRemoteRequests(endpointId: string) {
  const store = useStore();
  const entries = useJournal(endpointId);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const io = useMemo<RemoteIo>(() => ({
    dispatch: (entry) => {
      const request = resendArguments(entry);
      if (!request) throw new Error("This request cannot be rebuilt from its record.");
      return store.call<GithubRemoteReceipt>("source", request.name, request.args);
    },
    readReceipt: async (requestId) => (await store.call<{ receipt: GithubRemoteReceipt | null }>("source", "github_remote_receipt_get", { requestId })).receipt,
  }), [store]);
  const note = (requestId: string, text: string | null) => setNotes((held) => { const next = { ...held }; if (text) next[requestId] = text; else delete next[requestId]; return next; });
  const describe = (outcome: RemoteOutcome): string | null => !outcome.sent ? outcome.reason
    : outcome.readError ? `The receipt could not be read: ${outcome.readError}` : outcome.error && outcome.entry.status !== "succeeded" ? `Answer received: ${outcome.error}` : null;
  const send = async (entry: JournalEntry): Promise<RemoteOutcome> => {
    setBusy(entry.requestId); note(entry.requestId, null);
    try { const outcome = await sendRemote(browserStorage(), io, entry); note(entry.requestId, describe(outcome)); return outcome; } finally { setBusy(null); }
  };
  const read = async (entry: JournalEntry): Promise<RemoteOutcome> => {
    setBusy(entry.requestId); note(entry.requestId, null);
    try { const outcome = await recover(browserStorage(), io, entry); note(entry.requestId, outcome.readError ? `The receipt could not be read: ${outcome.readError}` : null); return outcome; } finally { setBusy(null); }
  };
  return { entries, busy, notes, send, read, forget: (entry: JournalEntry) => { forget(browserStorage(), entry.endpointId, entry.requestId); note(entry.requestId, null); } };
}
export type RemoteRequests = ReturnType<typeof useRemoteRequests>;

/** The requests this browser recorded, each with the owner's receipt for it and only the actions that are safe for its state. */
export function RequestList({ requests, connected, className }: { requests: RemoteRequests; connected: boolean; className?: string }) {
  const { entries } = requests;
  if (!entries.length) return null;
  return (
    <section aria-label="Recorded requests" className={className ?? "flex flex-col gap-2"}>
      <span className={sourceLabel}>Requests recorded in this browser</span>
      <ul className="flex flex-col gap-2">
        {[...entries].reverse().map((entry) => {
          const view = entryWords(entry), working = requests.busy === entry.requestId;
          return (
            <li key={entry.requestId} data-request={entry.requestId} data-status={entry.status} className="flex flex-col gap-1 rounded-lg border bg-background/60 p-2 text-[0.72rem]">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{remoteKindWords[entry.kind]}</span>
                <Word tone={view.tone} className="text-[0.72rem]">{view.word}</Word>
                <Stamp at={entry.at} className="ml-auto text-muted-foreground" />
              </div>
              <p className="min-w-0 break-words text-muted-foreground">{entry.intent}</p>
              <p className="flex min-w-0 items-center gap-1 text-[0.68rem] text-muted-foreground">Request <code className="min-w-0 truncate font-mono" title={entry.requestId}>{entry.requestId}</code>
                <CopyButton value={entry.requestId} label="request ID" className="opacity-100" /></p>
              <p className="text-pretty">{view.text}</p>
              {requests.notes[entry.requestId] ? <p role="status" className="text-warning">{requests.notes[entry.requestId]}</p> : null}
              <div className="flex flex-wrap items-center gap-1.5">
                {canReadReceipt(entry) ? (
                  <Button size="xs" variant="outline" disabled={!connected || working} onClick={() => void requests.read(entry)}>
                    {working ? <Spinner data-icon="inline-start" /> : <BookCheckIcon data-icon="inline-start" />}Read receipt
                  </Button>
                ) : null}
                {canSendAgain(entry) ? (
                  <Button size="xs" variant="outline" disabled={!connected || working} onClick={() => void requests.send(entry)} title="Sends the same request again under the same request ID; the owner never recorded it, so it did not reach GitHub.">
                    {working ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}Send again (same request ID)
                  </Button>
                ) : null}
                <Button size="xs" variant="ghost" disabled={working} onClick={() => requests.forget(entry)} title="Stops tracking this request here. The owner keeps its receipt.">
                  <Trash2Icon data-icon="inline-start" />Forget this request
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className={sourceHint}>A request is never sent again under a new ID. Reading a receipt changes nothing; forgetting only stops tracking it here.</p>
    </section>
  );
}
