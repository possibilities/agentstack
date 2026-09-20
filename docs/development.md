# Development

Requirements are Node 24 or newer and pnpm 11.25.0. Runtime releases include their own pinned Node 24 binary.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm stage
pnpm verify:payload
pnpm package:deb
pnpm inspect:deb
```

Libraries compile with strict NodeNext TypeScript and explicit exports. App builds use esbuild only to create self-contained ESM entrypoints and record metafiles. Turbo owns the package task graph; packaging and live qualification remain explicit uncached steps.

Integration tests use executable fake children. They test direct ownership, initialize readiness, bounded retries, auth-required stability, single-child restart, shutdown, control-socket permissions, and unsafe stale paths without network access or credentials.

Never point development tests at global `fx` or `codex`. Use only `vendor/manifest.json` payloads for release qualification.
