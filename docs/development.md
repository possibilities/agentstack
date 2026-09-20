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

The observed Darwin arm64 and Linux x86-64 Fx bytes differ even with the same source, Zig version, target and optimization; this evidence does not establish why. `stage-release.mjs` rejects the Darwin development observation. The Linux digest remains a release candidate until two isolated-cache Linux builds compare byte-for-byte and match it.
