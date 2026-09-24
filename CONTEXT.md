# Context

## Package API

Typed operations a workspace package exports so agentstack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the names. `mcp` exposes operations over loopback HTTP through the running socket Servers; it does not expose event subscriptions. `websocket` exposes operations and event subscriptions over a shared loopback listener, forwarding to those same socket Servers.

_Avoid_: protocol, binding

## Event

A named change notice a Package API publishes on an event-capable transport. Topics and descriptions are declared in TypeScript on the PackageApi (`events`); the socket transport delivers them to connections that call `events/subscribe`. A Package API can require a subscription scope (such as a bot ID), which filters notices without adding data to them. A notice carries only the topic name — never a payload or credentials — so callers snapshot state after (re)subscribing.

_Avoid_: stream, feed, pubsub

## Server

One named composition of a Package API. The name is the namespace for its socket.

_Avoid_: daemon, service, app

## Codex account

An AgentStack-owned sign-in credential with an immutable account ID managed by the `auth` Package API for a managed Codex Server. One account is active for new Servers. A Server may be created unbound. An existing Server changes account only through assignment, then the next start after a stop. A running Server reports both its assignment and its launched identity. Removing either account deletes that Server. A Server never takes a human-facing ordinal. A future UI may present dense `codex-N` labels derived from the current account list. _Avoid_: Codex home, capability profile

## Main thread

The single Codex thread ID retained by a managed Server. A fresh Server has no main thread until the first persistent root thread created by a connected UI has a durable turn; later Server launches resume that ID. Only this root and its descendants belong to AgentStack's view of the Server. Other Codex top-level threads on the same socket are ignored.

## Bot

A numbered Codex Server with a private workspace and, after its first turn, a durable main thread. A Bot may start without an account. Assign an account, then stop and start, before a turn. Turns require a bound account. Bots restart on AgentStack startup and resume their main thread when one exists.

## Default capabilities bundle

AgentStack's shared specification for every managed Server and Bot: ordered instruction fragments, owner MCP connections, and a reserved skills directory. Each process receives a private launch snapshot through codexnk's `--capabilities` directory. Edits affect later launches, not a running process. _Avoid_: system-prompt flag, live prompt file

## Category

An ordered group of instruction fragments in the default capabilities bundle. Its title and description help humans manage content but do not render into the prompt. Disabling it suppresses all its fragments.

## Fragment

A durable, ordered developer-instruction body with a stable ID and human-only title and description. Only enabled fragments in enabled categories enter `SYSTEM_APPEND.md`.
