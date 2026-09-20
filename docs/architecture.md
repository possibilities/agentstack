# Architecture

Milestone one is a process-supervision spine, not a conversation product. `systemd --user` starts one AgentStack daemon. The daemon starts exactly one immediate foreground child and retains its stdio transports:

```text
systemd --user
  agentstack daemon
    codex-app-server
```

The daemon resolves one immutable release root at startup, constructs product-controlled absolute launch specifications, and gives every launch a new generation UUID. It keeps process state separate from protocol readiness. Late output and exit events are ignored when their generation is no longer current.

Codex readiness is the documented app-server `initialize` response followed by `initialized`. The probe creates no thread, session, turn, prompt, or inference. Codex uses a private product state root instead of the operator's personal configuration.

The only local API is a mode-0600 Unix socket inside a mode-0700 same-user directory. HTTP/1.1 JSON exposes `GET /v1/status` and `POST /v1/children/codex/restart`. The request router and client transport are separate contracts, so a future authenticated desktop/static-UI server can reuse bounded operations without scraping the CLI or hardcoding Unix-socket access. Status includes `agentstack.system.v1`, a validated registry of every product-owned component with safe identity, ownership, process state, readiness, provenance, capabilities, and preference descriptors. This is the source for the future System surface: Overview, Processes, Accounts & Usage, Updates, and Preferences. Requests cannot supply executables, arguments, environments, prompts, or raw RPC payloads.

Current toolchain conventions follow the official [Turbo basic workspace](https://github.com/vercel/turborepo/tree/main/examples/basic), [compiled internal package guidance](https://turborepo.com/docs/core-concepts/internal-packages), and explicit package exports. The two app entrypoints are self-contained ESM bundles; end users do not need pnpm or a system Node installation.

The next UI consumes a bounded product API behind `packages/contracts`; it does not attach directly to engine stdio. The future macOS app reuses daemon and engine contracts while replacing Linux service operations with `SMAppService` and adding an `LSUIElement` menu shell.

Milestone one persists no user preferences and introduces no JSON, TOML, or environment-driven user configuration. The future System and CLI configuration seam is reserved for versioned shipped-defaults SQLite plus sparse per-user `config.sqlite3` overrides, with protected secrets in a separate `secrets.sqlite3`; internal launch environment variables remain process plumbing rather than product settings.
