# Context

## Package API

Typed operations a workspace package exports so agentstack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the names. `socket` and `websocket` run today.

_Avoid_: protocol, binding

## Server

One named composition of a Package API. The name is the namespace for its socket.

_Avoid_: daemon, service, app

## UI

Each package's page is a React Server Component under `ui/`, rendered by a Next.js dev server embedded in `agentstack serve` (`packages/owner/web`). Pages call the package's own server actions — no HTTP data endpoints. A loopback websocket event invalidates the client, which calls `router.refresh()` to repaint. Styling is Tailwind with shadcn conventions (`cn`, `cva`, CSS-variable tokens in `web/app/globals.css`) — no other UI libraries.

_Avoid_: endpoint, widget

## Codex account

An AgentStack-owned sign-in credential and stable `codex-N` name for a managed Codex Server. One account is active for new Servers; an existing Server retains the account recorded at its launch. _Avoid_: Codex home, capability profile

## Main thread

The single Codex thread ID retained by a managed Server. Its first successful launch creates the thread; later launches resume that same ID. Child threads belong to the Codex session, not to the Server's main-thread binding.

## Bot

A numbered Codex Server with a private workspace and a durable main thread. Bots restart on AgentStack startup and resume their bound thread.
