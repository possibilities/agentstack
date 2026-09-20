# Vendor provenance

Rebuild and verify only the pinned `node` and `codex` payloads before packaging.
Do not substitute a globally installed `codex` binary:

```sh
scripts/vendor/fetch-node.sh
scripts/vendor/fetch-codex.sh
scripts/vendor/verify.sh
```

Node uses an exact upstream Linux x64 release. Codex uses the official Linux
app-server package whose archive and executable digests are recorded in
`vendor/manifest.json`. License texts under `vendor/licenses/` ship with the
Debian artifact.

`.github/workflows/native-linux.yml` is the release authority. Every action is
pinned to a full commit. The job reconstructs Node and Codex from locked
sources, builds and compares the package twice, inspects internal payload
hashes, retains CI evidence, and publishes a package, checksums, static release
manifest, and GitHub artifact attestations from an exact `v<productVersion>`
tag.

Fx ACP support was removed; AgentStack is Codex-only.
