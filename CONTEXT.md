# Context

## Package API

Typed operations a workspace package exports so agentstack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the names. `mcp` exposes operations over loopback HTTP through the running socket Package APIs; it does not expose event subscriptions. `websocket` exposes operations and event subscriptions over a shared loopback listener, forwarding to those same socket Package APIs.

_Avoid_: protocol, binding

## Event

A named change notice a Package API publishes on an event-capable transport. Topics and descriptions are declared in TypeScript on the PackageApi (`events`); the socket transport delivers them to connections that call `events/subscribe`. A Package API can require a subscription scope (such as a bot ID), which filters notices without adding data to them. A notice carries only the topic name — never a payload or credentials — so callers snapshot state after (re)subscribing.

_Avoid_: stream, feed, pubsub

## Codex account

An AgentStack-owned sign-in credential with an immutable account ID managed by the `auth` Package API for Bots. One account is active for new Bots. A Bot may be created unbound. An existing Bot changes account only through assignment, then the next start after a stop. A running Bot reports both its assignment and its launched identity. Removing either account deletes that Bot. Accounts never take a durable human-facing ordinal. A UI may present dense `codex-N` labels derived from the current account list. _Avoid_: Codex home, capability profile

## Main thread

The single Codex thread ID retained by a Bot. A fresh Bot has no main thread until the first persistent root thread created by a connected UI has a durable turn; later Bot launches resume that ID. Only this root and its descendants belong to AgentStack's view of the Bot. Other Codex top-level threads on the same socket are ignored.

## Bot

A Codex app-server process with, after its first turn, a durable main thread. By default it is numbered `bot-N` with a private workspace; `bot_start` can override its ID, working directory, and launch arguments. A Bot may start without an account. Assign an account, then stop and start, before a turn. Turns require a bound account. Bots restart on AgentStack startup and resume their main thread when one exists.

## Default capabilities bundle

AgentStack's shared specification for every Bot: ordered instruction fragments, owner MCP connections, and a reserved skills directory. Each process receives a private launch snapshot through codexnk's `--capabilities` directory. Edits affect later launches, not a running process. _Avoid_: system-prompt flag, live prompt file

## Category

An ordered group of instruction fragments in the default capabilities bundle. Its title and description help humans manage content but do not render into the prompt. Disabling it suppresses all its fragments.

## Fragment

A durable, ordered developer-instruction body with a stable ID and human-only title and description. Only enabled fragments in enabled categories enter `SYSTEM_APPEND.md`.

## Voice call

One ephemeral, full-duplex WebRTC audio session into a running Bot's existing main thread. The Bots Package API relays an SDP offer and answer, tracks the exact call ID, and stops only native realtime on hang-up; it never creates a thread or ends a turn. The browser owns microphone capture and speaker playback.

_Avoid_: voice agent, voice thread
