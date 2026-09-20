# Development

Requirements are Node 24 or newer and pnpm 11.25.0. Runtime releases include their own pinned Node 24 binary.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm stage
pnpm verify:payload
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" \
  node scripts/package-deb.mjs --stage artifacts/stage-agentstack-0.1.1-linux-x64 --output artifacts/deb
node scripts/inspect-deb.mjs --package artifacts/deb/agentstack_0.1.1_amd64.deb --json
```

Libraries compile with strict NodeNext TypeScript and explicit exports. App builds use esbuild only to create self-contained ESM entrypoints and record metafiles. Turbo owns the package task graph; packaging and live qualification remain explicit uncached steps.

Integration tests use executable fake children. They test direct ownership, initialize readiness, bounded retries, auth-required stability, single-child restart, shutdown, control-socket permissions, and unsafe stale paths without network access or credentials.

These local commands are development checks. `.github/workflows/native-linux.yml` is the native-package release authority and must pass from the public tagged revision. Never point development tests at global `fx` or `codex`. Use only `vendor/manifest.json` payloads for release qualification.

Fx output bytes are compiler-host scoped even with the same Zig version and Linux target. Darwin arm64 may reproduce the committed development cross-build observation, but `stage-release.mjs` intentionally rejects those bytes. Only the twice-built, byte-compared Linux x86-64 output with the manifest's qualified digest can enter a Debian release.
