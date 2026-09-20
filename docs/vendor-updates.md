# Vendor updates

Each component in `vendor/manifest.json` records its exact source identity, target, source or archive checksum, shipped executable checksum, build toolchain, license paths, and payload location. The executable checksum is the staging authority; archive checksums remain separate provenance.

Node uses an exact upstream Node 24 Linux x64 release. Fx is an unmodified Linux build from `possibilities/fx` integration commit `e639de6aded41ae168a8888b920ff71db41877d0` with the pinned Zig compiler. Codex is the official 0.155.1 Linux package whose upstream archive SHA-256 is `a1784b0f3991e4853caaddcc167d2bc8c540f12eddb1b5e40b1ec49f2dbcc024`.

To update an engine, change one manifest entry, reproduce or retrieve the exact payload, verify licenses and hashes, run `pnpm verify`, stage and inspect the payload, build the Debian package, and repeat the live inference-free qualification. Do not substitute mutable branches, another product's cached binary, or a globally installed command.

`.github/workflows/native-linux.yml` is the release authority. Every action is pinned to a full commit. The job reconstructs Node, Codex, Zig and Fx from locked sources, builds and compares the package twice, inspects internal payload hashes, retains CI evidence, and publishes a package, `SHA256SUMS`, static `agentstack.release.v1` manifest and GitHub artifact attestations from an exact `v<productVersion>` tag. The public repository must enable immutable releases before the first publication.

Fx is also built twice from isolated Zig caches in the Linux x86-64 job and compared before staging. Its qualified executable digest is host-scoped: a separately recorded Darwin arm64 cross-build digest is diagnostic evidence and is never accepted as the Linux release payload.
