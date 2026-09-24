# 28. Dial native realtime into the existing main thread

Status: accepted, 2026-09-24. Extends [lazy main-thread binding](0026-lazy-server-main-thread.md) and [ADR 0024](0024-live-canvas-workbench.md)'s initial read-only canvas with an explicitly requested call control.

The voice operations moved from the Codex Package API to Bots in [ADR 0029](0029-bots-own-codex-lifecycle.md); the single-call and main-thread behavior remains.

The Codex Package API owns one ephemeral voice call across all its Servers. `voice_dial` requires a verified running Server with an account and a durable `mainThreadId`. It sends the browser's completed WebRTC SDP offer to Codex `thread/realtime/start` on that ID, with v3 audio output, then returns the SDP answer after Codex's `started` notification. It does not allocate or resume a different thread. It leaves the native voice model, prompt, voice and handoff policy at Codex defaults. The browser owns microphone capture, audio playback and its peer connection; the Package API never transports media.

Managed Codex launches enable the native `realtime_conversation` feature. Already-running processes need their ordinary stop/start cycle to pick up that launch argument; this change does not restart them.

`voice_status` exposes the active call's ID, Server, main thread and phase. `voice_hangup` takes that exact call ID and calls native `thread/realtime/stop`; stale IDs cannot end a newer call. `voice_changed` is a payload-free invalidation notice. The call is not persisted across owner or Codex process restarts. A failed or closed Codex connection clears the active call. This retains the ongoing thread and regular turns when the person hangs up, while keeping the initial single-call rule simple. The `/x` widget is the only canvas mutation here; `/x.md` reports call status.

Codex's realtime session is per thread and can also be controlled by another direct Codex client. This API guarantees one AgentStack-managed call, not exclusive ownership of every outside connection. A connected browser that disappears may leave a native call until the person hangs up or the Codex connection closes; status and exact-ID hang-up provide recovery.
