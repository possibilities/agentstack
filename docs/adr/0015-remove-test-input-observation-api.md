# 15. Remove test input observation from Package APIs

Status: accepted, 2026-09-24. Supersedes the `inputs_changed` portion of [ADR 0007](0007-bot-scoped-change-events.md).

The pass-through observer was a test of Codex input middleware. Its `input_observe_start`, `input_observe_stop`, and `input_observe_list` operations have no current client after the UI was removed, and the in-memory log is not a useful user-facing contract. Remove those operations from the Codex Package API, along with the Codex and bots `inputs_changed` events and the unused observer implementation. This also stops exposing observed prompt text through Package API calls.

Keep the lower-level `attachInputMiddleware` library client and its tests for a future script-backed input policy. Define script discovery and lifecycle before adding any corresponding Package API operations; do not preserve a pass-through test control surface in the meantime.
