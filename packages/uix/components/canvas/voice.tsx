"use client";

import { createContext, use, useEffect, useRef, useState } from "react";
import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, Volume2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortId } from "@/lib/stack/derive";
import type { Bot } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { BotTile } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";

export type VoicePhase = "idle" | "preparing" | "dialing" | "connected" | "ending";

export type Voice = {
  phase: VoicePhase;
  /** Session id of the call this page owns. */
  sessionId: string | null;
  /** Bot the active call belongs to — ours or one observed through `voice_status`. */
  botId: string | null;
  /** A call is in progress, here or elsewhere. */
  busy: boolean;
  /** The active call was dialed by this page (not one observed through `voice_status`). */
  ownCall: boolean;
  muted: boolean;
  autoplayBlocked: boolean;
  startedAt: number | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** Why a bot cannot be called, or null when it can. */
  callable(bot: Bot): string | null;
  dial(botId: string): void;
  hangup(): void;
  toggleMute(): void;
  enableAudio(): void;
};

const VoiceContext = createContext<Voice | null>(null);

export function useVoice(): Voice {
  const value = use(VoiceContext);
  if (!value) throw new Error("useVoice requires VoiceProvider");
  return value;
}

export function callable(bot: Bot): string | null {
  if (bot.state !== "running") return "Stopped";
  if (bot.recoveryIssue) return "Needs inspection";
  if (!bot.mainThreadId) return "Needs first turn";
  if (!bot.url || !bot.runningAccount) return "Account not launched";
  return null;
}

function voiceError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Microphone access is blocked. Allow it in this site's settings, then dial again.";
    if (error.name === "NotFoundError") return "No microphone found.";
  }
  return errorMessage(error);
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

function callClock(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { voice, status } = useStack();
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  const [dialedBot, setDialedBot] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const media = useRef<MediaStream | null>(null);
  const session = useRef<string | null>(null);
  /** True once `voice_status` has confirmed our session, so a later disappearance means the call ended remotely. */
  const seen = useRef(false);
  /** Whether the call currently ending was dialed by this page. */
  const endingOurs = useRef(false);
  const generation = useRef(0);

  const setSession = (id: string | null) => {
    session.current = id;
    setSessionIdState(id);
  };

  const clearMedia = () => {
    peer.current?.close();
    peer.current = null;
    media.current?.getTracks().forEach((track) => track.stop());
    media.current = null;
    if (audio.current) audio.current.srcObject = null;
    setLocalStream(null);
    setRemoteStream(null);
    setSession(null);
    setDialedBot(null);
    seen.current = false;
    setStartedAt(null);
    setMuted(false);
    setAutoplayBlocked(false);
  };

  // The call ends on the bot only after voice_status has actually reported our
  // session; until then a lagging refresh is not proof the call is gone.
  useEffect(() => {
    const active = voice.data;
    if (session.current && active?.sessionId === session.current) seen.current = true;
    if (session.current && seen.current && (!active || active.sessionId !== session.current) && !voice.error && phase !== "ending") {
      generation.current++;
      clearMedia();
      setPhase("idle");
      toast("Call ended");
    }
  }, [voice.data, voice.error, phase]);

  useEffect(() => {
    const leaving = () => {
      const id = session.current;
      if (id) void store.call("bots", "voice_hangup", { sessionId: id }).catch(() => undefined);
      generation.current++;
      clearMedia();
    };
    window.addEventListener("pagehide", leaving);
    return () => { window.removeEventListener("pagehide", leaving); leaving(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dial = async (botId: string) => {
    if (phase !== "idle" || voice.data || status.bots !== "open") return;
    const attempt = ++generation.current;
    const id = crypto.randomUUID();
    setPhase("preparing");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (attempt !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      media.current = stream;
      setLocalStream(stream);
      const connection = new RTCPeerConnection();
      peer.current = connection;
      setSession(id);
      setDialedBot(botId);
      connection.createDataChannel("oai-events");
      stream.getAudioTracks().forEach((track) => connection.addTrack(track, stream));
      connection.ontrack = (event) => {
        if (attempt !== generation.current) return;
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStream(remote);
        if (audio.current) {
          audio.current.srcObject = remote;
          void audio.current.play().catch(() => setAutoplayBlocked(true));
        }
      };
      connection.onconnectionstatechange = () => {
        if (attempt !== generation.current || connection.connectionState !== "failed") return;
        toast.error("Audio connection lost");
        void store.call("bots", "voice_hangup", { sessionId: id }).catch(() => undefined);
        generation.current++;
        clearMedia();
        setPhase("idle");
      };
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIce(connection);
      if (attempt !== generation.current) return;
      setPhase("dialing");
      const result = await store.call<{ sessionId: string; answer: string }>("bots", "voice_dial", {
        botId, sessionId: id, sdp: connection.localDescription?.sdp,
      });
      if (attempt !== generation.current) return;
      await connection.setRemoteDescription({ type: "answer", sdp: result.answer });
      if (attempt !== generation.current) return;
      setPhase("connected");
      setStartedAt(Date.now());
    } catch (error) {
      if (attempt !== generation.current) return;
      clearMedia();
      setPhase("idle");
      toast.error(voiceError(error));
    }
  };

  const hangup = async () => {
    const id = voice.data?.sessionId ?? session.current;
    if (!id) {
      // Nothing on the server yet (e.g. still in the permission prompt) — cancel locally.
      if (phase === "idle") return;
      generation.current++;
      clearMedia();
      setPhase("idle");
      return;
    }
    if (phase === "ending") return;
    const attempt = ++generation.current;
    endingOurs.current = id === session.current;
    setPhase("ending");
    clearMedia();
    try {
      await store.call("bots", "voice_hangup", { sessionId: id });
      if (attempt === generation.current) setPhase("idle");
    } catch (error) {
      if (attempt === generation.current) {
        setPhase("idle");
        toast.error(errorMessage(error));
      }
    }
  };

  const value: Voice = {
    phase,
    sessionId,
    botId: dialedBot ?? voice.data?.botId ?? null,
    busy: phase !== "idle" || voice.data !== null,
    ownCall: sessionId !== null || (phase !== "idle" && (phase !== "ending" || endingOurs.current)),
    muted,
    autoplayBlocked,
    startedAt,
    localStream,
    remoteStream,
    callable,
    dial: (botId) => void dial(botId),
    hangup: () => void hangup(),
    toggleMute: () => {
      const next = !muted;
      media.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
      setMuted(next);
    },
    enableAudio: () => {
      void audio.current?.play().then(() => setAutoplayBlocked(false), () => undefined);
    },
  };

  return (
    <VoiceContext value={value}>
      {children}
      <audio ref={audio} autoPlay playsInline className="hidden" />
      <CallDock />
    </VoiceContext>
  );
}

/* ─── Level meter ────────────────────────────────────────────────────── */

function Meter({ stream, label, className }: { stream: MediaStream | null; label: string; className?: string }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (!stream || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const weights = [0.45, 0.8, 1, 0.7, 0.35];
    let level = 0;
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.min(1, Math.sqrt(sum / data.length) * 4);
      level += (rms - level) * (rms > level ? 0.5 : 0.12);
      bars.current.forEach((bar, index) => {
        if (bar) bar.style.height = `${3 + Math.round(level * weights[index] * 13)}px`;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); source.disconnect(); void context.close(); };
  }, [stream]);
  return (
    <span className={cn("flex h-4 items-end gap-0.5", className)} role="img" aria-label={`${label} audio level`} title={label}>
      {[0, 1, 2, 3, 4].map((index) => (
        <span key={index} ref={(element) => { bars.current[index] = element; }} className="w-[3px] rounded-full bg-current transition-[height] duration-75" style={{ height: 3 }} />
      ))}
    </span>
  );
}

/* ─── Call dock ──────────────────────────────────────────────────────── */

function CallDock() {
  const voice = useVoice();
  const { voice: remote, bots } = useStack();
  const { goTo } = useWorkbench();
  const now = useNow();
  if (!voice.busy) return null;
  // While our own call is ending, voice.data may still report it — a call only
  // belongs elsewhere when this page never dialed it.
  const elsewhere = !voice.ownCall && remote.data && remote.data.sessionId !== voice.sessionId;
  const bot = bots.data?.find((item) => item.id === voice.botId);
  const statusText =
    voice.phase === "preparing" ? "Preparing microphone…"
    : voice.phase === "dialing" ? "Connecting…"
    : voice.phase === "ending" ? "Hanging up…"
    : voice.startedAt ? callClock(voice.startedAt, now)
    : "Connecting…";

  return (
    <aside data-chrome aria-label="Voice call" className="fixed top-16 z-30 -translate-x-1/2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-3" style={{ left: "calc(var(--system) + (100% - var(--system) - var(--sheet))/2)" }}>
      <div className="flex items-center gap-3 rounded-2xl border bg-card/80 py-1.5 pr-1.5 pl-2 whitespace-nowrap shadow-sm backdrop-blur-xl">
        {elsewhere ? (
          <>
            <span className="flex size-9 items-center justify-center rounded-xl bg-pkg-bots/12 text-pkg-bots"><PhoneIcon className="size-4" /></span>
            <span className="text-[0.8rem] font-medium">On call elsewhere{voice.botId ? ` · ${voice.botId}` : ""}</span>
            <Button size="sm" variant="destructive" className="ml-1" disabled={voice.phase === "ending"} onClick={voice.hangup}>End call</Button>
          </>
        ) : (
          <>
            <button
              type="button"
              aria-label={voice.botId ? `Go to ${voice.botId}` : "Go to bot"}
              onClick={() => voice.botId && goTo({ kind: "bot", id: voice.botId })}
              className="rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
            >
              <BotTile bot={bot} className="size-9 rounded-lg text-sm [&_svg]:size-4" />
            </button>
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="font-mono text-[0.8rem] font-semibold whitespace-nowrap">{voice.botId}</span>
              <span role="status" className="flex items-center gap-1 text-[0.68rem] whitespace-nowrap text-muted-foreground tabular-nums">
                {voice.phase === "connected" ? <span aria-hidden className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" /> : <Spinner className="size-2.5" />}
                {statusText}
              </span>
            </div>
            {voice.phase === "connected" ? (
              <>
                <Separator orientation="vertical" className="mx-0.5 h-6! self-center" />
                <span className="flex flex-col items-center gap-0.5 text-muted-foreground" title="You">
                  <Meter stream={voice.localStream} label="You" />
                  <span className="hidden text-[0.62rem] sm:inline">You</span>
                </span>
                <span className="flex flex-col items-center gap-0.5 text-pkg-bots" title={voice.botId ?? "Bot"}>
                  <Meter stream={voice.remoteStream} label={voice.botId ?? "Bot"} />
                  <span className="hidden text-[0.62rem] whitespace-nowrap sm:inline">{voice.botId}</span>
                </span>
                <Separator orientation="vertical" className="mx-0.5 h-6! self-center" />
              </>
            ) : null}
            {voice.autoplayBlocked ? (
              <Button size="sm" variant="secondary" onClick={voice.enableAudio}>
                <Volume2Icon data-icon="inline-start" />
                Enable audio
              </Button>
            ) : null}
            {voice.phase === "connected" ? (
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={voice.muted} onClick={voice.toggleMute} />}
                >
                  {voice.muted ? <MicOffIcon className="text-destructive" /> : <MicIcon />}
                </TooltipTrigger>
                <TooltipContent side="bottom">{voice.muted ? "Unmute" : "Mute"}</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="destructive" size="icon-lg" className="rounded-full" aria-label="Hang up" disabled={voice.phase === "ending"} onClick={voice.hangup} />}
              >
                <PhoneOffIcon />
              </TooltipTrigger>
              <TooltipContent side="bottom">Hang up</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </aside>
  );
}

/* ─── Top bar entry ──────────────────────────────────────────────────── */

export function CallLauncher() {
  const voice = useVoice();
  const { bots } = useStack();
  const [open, setOpen] = useState(false);
  const list = bots.data ?? [];
  const dialing = voice.phase === "preparing" || voice.phase === "dialing";
  const inCall = voice.busy && !dialing;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex" />
          }
        >
          <PopoverTrigger
            render={<Button variant="outline" size="icon" className="size-10 rounded-xl bg-card/80 shadow-sm backdrop-blur-xl" aria-label={inCall ? "On a call" : "Call a bot"} disabled={voice.busy} />}
          >
            {dialing ? <Spinner /> : (
              <span className="relative">
                <PhoneIcon />
                {inCall ? <span aria-hidden className="absolute -top-1 -right-1 size-2 rounded-full bg-success ring-1 ring-card" /> : null}
              </span>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{inCall ? "On a call" : "Call a bot"}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={8} className="w-72 gap-0 p-1.5">
        {list.length ? (
          <ul className="flex flex-col">
            {list.map((bot) => {
              const reason = callable(bot);
              return (
                <li key={bot.id} className={cn("flex items-center gap-2.5 rounded-lg px-1.5 py-1.5", reason && "opacity-55")}>
                  <BotTile bot={bot} className="size-8 rounded-lg text-xs [&_svg]:size-3.5" />
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="font-mono text-[0.8rem] font-medium">{bot.id}</span>
                    <span className="text-[0.68rem] text-muted-foreground">
                      {bot.mainThreadId ? `main thread ${shortId(bot.mainThreadId)}` : `${bot.state}${bot.pid ? ` · pid ${bot.pid}` : ""}`}
                    </span>
                  </div>
                  {reason ? (
                    <span className="ml-auto shrink-0 text-[0.68rem] text-muted-foreground">{reason}</span>
                  ) : (
                    <Button size="xs" variant="outline" className="ml-auto" onClick={() => { setOpen(false); voice.dial(bot.id); }}>
                      <PhoneIcon data-icon="inline-start" />
                      Call
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="flex flex-col items-center gap-1.5 px-3 py-5 text-center">
            <PhoneIcon className="size-4 text-muted-foreground/70" />
            <span className="text-[0.8rem] font-medium">No bots to call</span>
            <span className="text-[0.7rem] text-pretty text-muted-foreground">Start a bot, give it a first turn, then call its main thread.</span>
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
