# 53. Submit speech on the exact connected Bot call

Status: accepted, 2026-09-25. Extends [ADR 0028](0028-main-thread-voice-call.md)'s single main-thread call after its move to Bots in [ADR 0029](0029-bots-own-codex-lifecycle.md).

`voice_speak` accepts a bounded nonblank announcement and the exact `sessionId` returned by `voice_dial` (also visible in `voice_status`). Only the connected call accepts speech, and a Bot-bound MCP caller may speak only on its own Bot's call. The Bots process sends `thread/realtime/appendSpeech` on the call's existing initialized app-server connection, so it cannot accidentally target a new Bot or a different thread. It does not create a turn, change the call state, or publish `voice_changed`; there is no new canvas control.

The result is `status: submitted` with the same call ID. Codex's RPC acknowledgement is not an audio-playback receipt: the realtime model may paraphrase, truncate, or fail after submission. Speech is not idempotent; callers must not blindly retry an uncertain result. This keeps announcement integrations separate from conversation input (`appendText`) and from browser-owned microphone/audio playback.
