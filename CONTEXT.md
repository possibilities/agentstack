# Context

## Package API

Typed operations a workspace package exports so agentstack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the names. Only `socket` runs today.

_Avoid_: protocol, binding

## Server

One named composition of a Package API. The name is the namespace for its socket.

_Avoid_: daemon, service, app

## UI

Each package's page is a React Server Component under `ui/`, rendered by a Next.js dev server embedded in `agentstack serve` (`packages/owner/web`). Pages call the package's own server actions — no HTTP data endpoints. The client polls the action each second to repaint.

_Avoid_: endpoint, widget
