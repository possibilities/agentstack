"use client";

import { useEffect, useRef, useState } from "react";
import { HeadphonesIcon, MicIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Server, VoiceCall } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useStack, useStore } from "./provider";

type LocalPhase = "idle" | "preparing" | "dialing" | "connected" | "ending";

function ready(server: Server): boolean {
  return server.state === "running" && !server.recoveryIssue && Boolean(server.url && server.mainThreadId && server.runningAccount);
}

function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Audio negotiation timed out")); }, 15_000);
    const changed = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); };
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

export function VoiceWidget() {
  const { servers, bots, voice, status } = useStack();
  const store = useStore();
  const [target, setTarget] = useState("");
  const [phase, setPhase] = useState<LocalPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [microphoneOn, setMicrophoneOn] = useState(true);
  const audio = useRef<HTMLAudioElement>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const media = useRef<MediaStream | null>(null);
  const session = useRef<string | null>(null);
  const generation = useRef(0);

  const available = (servers.data ?? []).filter(ready);
  const botIds = new Set(bots.data?.map((bot) => bot.id));
  const selected = available.some((server) => server.id === target) ? target : available[0]?.id ?? "";
  const active = voice.data;
  const connected = phase === "connected" && active?.sessionId === session.current;
  const busy = active !== null || phase !== "idle";

  const clearMedia = () => {
    peer.current?.close();
    peer.current = null;
    media.current?.getTracks().forEach((track) => track.stop());
    media.current = null;
    if (audio.current) audio.current.srcObject = null;
    session.current = null;
  };

  useEffect(() => {
    const pageIsLeaving = () => {
      generation.current++;
      clearMedia();
    };
    window.addEventListener("pagehide", pageIsLeaving);
    return () => { window.removeEventListener("pagehide", pageIsLeaving); pageIsLeaving(); };
  }, []);

  useEffect(() => {
    if (session.current && !active && !voice.error && phase !== "preparing" && phase !== "dialing" && phase !== "ending") {
      generation.current++;
      clearMedia();
      setPhase("idle");
      setMessage("Call ended on the Server.");
    }
  }, [active, voice.error, phase]);

  const dial = async () => {
    if (!selected || busy || status.codex !== "open") return;
    const attempt = ++generation.current;
    const id = crypto.randomUUID();
    setMessage(null);
    setMicrophoneOn(true);
    setPhase("preparing");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (attempt !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      media.current = stream;
      const connection = new RTCPeerConnection();
      peer.current = connection;
      session.current = id;
      connection.createDataChannel("oai-events");
      stream.getAudioTracks().forEach((track) => connection.addTrack(track, stream));
      connection.ontrack = (event) => {
        if (attempt !== generation.current || !audio.current) return;
        audio.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.current.play().catch(() => setMessage("Tap the speaker to play response audio."));
      };
      connection.onconnectionstatechange = () => {
        if (attempt !== generation.current) return;
        if (connection.connectionState === "failed") setMessage("Audio connection failed. Hang up and dial again.");
      };
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIce(connection);
      if (attempt !== generation.current) return;
      setPhase("dialing");
      const result = await store.call<{ sessionId: string; answer: string }>("codex", "voice_dial", {
        serverId: selected, sessionId: id, sdp: connection.localDescription?.sdp,
      });
      if (attempt !== generation.current) return;
      await connection.setRemoteDescription({ type: "answer", sdp: result.answer });
      if (attempt !== generation.current) return;
      setPhase("connected");
    } catch (error) {
      if (attempt !== generation.current) return;
      clearMedia();
      setPhase("idle");
      setMessage(error instanceof Error ? error.message : "Could not start the call");
    }
  };

  const hangup = async () => {
    const id = active?.sessionId ?? session.current;
    if (!id || phase === "ending") return;
    const attempt = ++generation.current;
    setPhase("ending");
    setMessage(null);
    clearMedia();
    try {
      // The Package API fences stale IDs; a stopped call remains safe to retry.
      await store.call("codex", "voice_hangup", { sessionId: id });
      if (attempt === generation.current) setPhase("idle");
    } catch (error) {
      if (attempt === generation.current) {
        setPhase("idle");
        setMessage(error instanceof Error ? error.message : "Could not hang up. Try again.");
      }
    }
  };

  return (
    <aside data-chrome aria-label="Voice call" className="pointer-events-auto fixed right-3 bottom-16 z-30 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border bg-card p-4 text-card-foreground shadow-lg sm:bottom-4">
      <audio ref={audio} autoPlay playsInline className="hidden" />
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl bg-pkg-codex/12 text-pkg-codex"><PhoneIcon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Voice call</h2>
          <p role="status" className="text-xs text-muted-foreground">
            {active ? `${active.phase === "connected" ? "Connected" : "Dialing"} · ${active.serverId}` : phase === "preparing" ? "Preparing microphone…" : phase === "dialing" ? "Connecting to Codex…" : phase === "ending" ? "Hanging up…" : "Call into a running main thread"}
          </p>
        </div>
        <span aria-hidden className={cn("size-2 rounded-full", active ? "bg-success" : "bg-muted-foreground/40")} />
      </div>
      {!active && phase === "idle" ? (
        <div className="mt-4 flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Server or Bot</span>
            <select value={selected} onChange={(event) => setTarget(event.target.value)} disabled={!available.length}
              className="h-10 w-full rounded-lg border bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring">
              {available.length ? available.map((server) => <option key={server.id} value={server.id}>{server.id}{botIds.has(server.id) ? " · Bot" : " · Server"}</option>) : <option value="">No callable Servers</option>}
            </select>
          </label>
          <Button onClick={() => void dial()} disabled={!selected || status.codex !== "open"} className="h-10 gap-2 rounded-lg"><PhoneIcon /> Dial</Button>
        </div>
      ) : (
        <div className="mt-4 flex gap-2">
          {connected ? <Button variant="outline" onClick={() => {
            const next = !microphoneOn;
            media.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
            setMicrophoneOn(next);
          }} aria-pressed={!microphoneOn} className="h-10 flex-1 gap-2 rounded-lg"><MicIcon />{microphoneOn ? "Mic on" : "Mic off"}</Button> : null}
          {connected ? <Button variant="outline" aria-label="Play response audio" onClick={() => void audio.current?.play()} className="h-10 gap-2 rounded-lg"><HeadphonesIcon /> Play</Button> : null}
          {session.current || active ? <Button variant="destructive" onClick={() => void hangup()} disabled={phase === "ending" || status.codex !== "open"} className="h-10 flex-1 gap-2 rounded-lg"><PhoneOffIcon /> Hang up</Button> : null}
        </div>
      )}
      {message ? <p role="alert" className="mt-3 text-xs text-destructive">{message}</p> : null}
      {!available.length && !active ? <p className="mt-3 text-xs text-muted-foreground">Start a Server with an account and send its first turn to create a main thread.</p> : null}
    </aside>
  );
}
