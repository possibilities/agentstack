"use client";

import { useState } from "react";
import { CornerDownLeftIcon, MegaphoneIcon, PhoneOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { shortId } from "@/lib/stack/derive";
import type { VoiceSpeechSubmission } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { BotTile, Empty, NodeLink, StatusDot, Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { Section, Window } from "./window";

/** Mirrors voice_speak's input limit. */
const maxLength = 4_000;
const keptSubmissions = 20;

type Submission = { id: string; text: string; sessionId: string; botId: string; at: number };

/**
 * Lab experiment: offer text to the open voice call through `voice_speak`, so the
 * call's realtime voice says it. The Bots API holds at most one call. A receipt
 * means Codex accepted the text, not that it was heard verbatim, so a failed
 * send is never retried automatically.
 */
export function CallSpeechWindow() {
  const store = useStore();
  const { voice, bots, status, endpoints } = useStack();
  const call = voice.data;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const bot = call ? bots.data?.find((item) => item.id === call.botId) : undefined;
  const blocked = status.bots !== "open" ? "Bots reconnecting" : !call ? "No open call" : call.phase !== "connected" ? "Call still connecting" : null;
  const canSend = !blocked && !sending && text.trim().length > 0;

  const send = async () => {
    if (!call || !canSend) return;
    const { sessionId, botId } = call;
    const spoken = text.trim();
    setSending(true);
    setError(null);
    try {
      await store.call<VoiceSpeechSubmission>("bots", "voice_speak", { sessionId, text: spoken });
      setSubmissions((list) => [{ id: crypto.randomUUID(), text: spoken, sessionId, botId, at: Date.now() }, ...list].slice(0, keptSubmissions));
      setText("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <Window id="call-speech" title="Call speech" icon={MegaphoneIcon} accent="bots" count={call ? 1 : 0}
      status={status.bots} endpoint={endpoints.bots} updatedAt={voice.at} error={voice.error} empty={!call && !submissions.length}>
      {call ? (
        <Section title="Open call">
          <div className="flex items-center gap-2.5 rounded-xl border p-2.5">
            <BotTile bot={bot} className="size-9 rounded-lg text-sm [&_svg]:size-4" />
            <div className="flex min-w-0 flex-col leading-tight">
              <NodeLink node={{ kind: "bot", id: call.botId }} label={call.botId} className="font-mono text-[0.8rem] font-semibold">{call.botId}</NodeLink>
              <span className="truncate font-mono text-[0.68rem] text-muted-foreground" title={`Call ${call.sessionId} on thread ${call.threadId}`}>
                call {shortId(call.sessionId)} · thread {shortId(call.threadId)}
              </span>
            </div>
            <span role="status" className="ml-auto flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
              <StatusDot tone={call.phase === "connected" ? "success" : "warning"} pulse={call.phase === "connected"} />
              {call.phase === "connected" ? "Connected" : "Dialing"}
            </span>
          </div>
        </Section>
      ) : (
        <Empty icon={PhoneOffIcon} title="No open call" />
      )}
      {call ? (
        <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label htmlFor="call-speech-text" className="sr-only">Text for {call.botId} to say</label>
          <Textarea id="call-speech-text" value={text} maxLength={maxLength} disabled={sending} placeholder={`Text for ${call.botId} to say`}
            aria-invalid={error ? true : undefined} aria-describedby={error ? "call-speech-error" : undefined}
            onChange={(event) => { setText(event.target.value); setError(null); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
            className="max-h-40 min-h-16 resize-none" />
          {error ? <p id="call-speech-error" role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
          <div className="flex items-center gap-2">
            <span className="text-[0.68rem] text-muted-foreground">{blocked ?? "Enter to send · Shift+Enter for a new line"}</span>
            <Button type="submit" size="sm" className="ml-auto" disabled={!canSend}>
              {sending ? <Spinner data-icon="inline-start" /> : <CornerDownLeftIcon data-icon="inline-start" />}
              Say
            </Button>
          </div>
        </form>
      ) : null}
      {submissions.length ? (
        <Section title="Submitted" aside={<span className="text-[0.65rem] text-muted-foreground">Playback not confirmed</span>}>
          <ul className="flex flex-col gap-1">
            {submissions.map((item) => (
              <li key={item.id}>
                <button type="button" title="Reuse this text" onClick={() => { setText(item.text); setError(null); }}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="line-clamp-2 text-[0.8rem] text-pretty">{item.text}</span>
                  <span className="flex gap-1 font-mono text-[0.65rem] text-muted-foreground">
                    {item.botId}{item.sessionId === call?.sessionId ? "" : ` · earlier call ${shortId(item.sessionId)}`} · <Time at={item.at} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </Window>
  );
}
