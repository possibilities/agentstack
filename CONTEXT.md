# Context

## Package API

Typed operations a workspace package exports so agentstack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the names. `mcp` exposes operations over loopback HTTP through the running socket Servers; it does not expose event subscriptions.

_Avoid_: protocol, binding

## Event

A named change notice a Package API publishes on an event-capable transport. Topics and descriptions are declared in TypeScript on the PackageApi (`events`); the socket transport delivers them to connections that call `events/subscribe`. A Package API can require a subscription scope (such as a bot ID), which filters notices without adding data to them. A notice carries only the topic name — never a payload or credentials — so callers snapshot state after (re)subscribing.

_Avoid_: stream, feed, pubsub

## Server

One named composition of a Package API. The name is the namespace for its socket.

_Avoid_: daemon, service, app

## Codex account

An AgentStack-owned sign-in credential and stable `codex-N` name managed by the `auth` Package API for a managed Codex Server. One account is active for new Servers; an existing Server retains the account recorded at its launch. _Avoid_: Codex home, capability profile

## Main thread

The single Codex thread ID retained by a managed Server. Its first successful launch creates the thread; later launches resume that same ID. Child threads belong to the Codex session, not to the Server's main-thread binding.

## Bot

A numbered Codex Server with a private workspace and a durable main thread. Bots restart on AgentStack startup and resume their bound thread.
