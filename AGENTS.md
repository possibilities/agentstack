# Repository instructions

Read [CONTEXT.md](CONTEXT.md) and [CONTEXT-MAP.md](CONTEXT-MAP.md) before changing runtime ownership, package layout, or product terminology. Decisions live in [docs/adr](docs/adr).

AgentStack milestone one is exactly one foreground daemon with one immediate native child: Codex app-server. Keep its stdin, stdout, stderr, process handle, generation, retries, and shutdown inside the daemon. Do not add a broker, scheduler, TCP listener, provider inference, authentication workflow, UI, or global Codex installation.

Run `pnpm verify`, stage the release, verify its payload, build the Debian package, and inspect the package before delivery. GitHub Actions is the authoritative native-package builder; public releases carry checksums, a static release manifest, inspection evidence, and GitHub artifact attestations. Live qualification must install an exact verified public release on an authorized Debian host, must not create a VM or provider turn, and must preserve user state and `Linger=no`.

Runtime payloads are pinned in `vendor/manifest.json`. Never substitute a globally installed command, mutable branch, or unverified download. Engine updates require provenance, licenses, executable hashes, deterministic compatibility checks, and a new qualification receipt.

Keep `README.md` to the exact canonical first line, one pitch sentence, and minimum install commands. Put all technical and operational detail in owned documentation.
