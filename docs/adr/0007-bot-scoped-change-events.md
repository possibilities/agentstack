# 7. Filter bot change events by subscription scope

Status: accepted, 2026-09-24. Builds on [ADR 0002](0002-private-control-transport.md) and [ADR 0006](0006-live-package-api-reference.md).

The bots Package API publishes `bots_changed`, `threads_changed`, and `inputs_changed` on its socket. A subscriber supplies a required `scope` containing a recorded bot ID. The socket validates that ID and delivers only changes for that bot; the acknowledgement echoes the scope, while notices still contain only the topic. Codex's corresponding events accept an optional Server-ID scope, preserving unscoped listeners that watch every Server. Discovery and the generated reference describe each Package API's scope and show the required field in the bots subscription example.

The bots API subscribes upstream for each recorded bot and verifies that the Codex Server with that ID uses the bot's private workspace. It reconnects after Codex socket interruptions and publishes invalidations after resubscribing, since events are not replayed. This avoids changing the event notice into a payload-bearing message or exposing another Server's thread/input activity to bot subscribers. A caller snapshots current state after subscribing and after each notice.
