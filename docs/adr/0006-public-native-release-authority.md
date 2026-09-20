# 0006: GitHub Actions owns public native releases

Status: accepted 2026-09-20.

GitHub Actions is the authoritative builder for native packages. Linux workflows use full-commit action pins and least job permissions, reconstruct every vendored payload from locked sources and checksums, compare two fixed-epoch Debian builds, inspect package-internal payload digests, and retain the evidence artifact.

An exact version tag publishes the `.deb`, checksums, inspection receipt, build environment and static `agentstack.release.v1` manifest. GitHub artifact attestations sign the package and evidence through OIDC. The repository must enable immutable releases. Qualification hosts download the exact public tag and verify the package against both `SHA256SUMS`, the release manifest and an out-of-band expected SHA-256 before installation.

macOS signing, notarization and DMG publication remain a later workflow. Linux release machinery does not emit placeholder Apple signing evidence.
