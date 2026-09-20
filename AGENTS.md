# Repository instructions

Read [CONTEXT.md](CONTEXT.md) and [CONTEXT-MAP.md](CONTEXT-MAP.md) before changing runtime ownership, package layout, or product terminology. Decisions live in [docs/adr](docs/adr).

AgentStack milestone one is exactly one foreground daemon with two immediate native children: Fx ACP and Codex app-server. Keep their stdin, stdout, stderr, process handles, generations, retries, and shutdown inside the daemon. Do not add a broker, scheduler, TCP listener, provider inference, authentication workflow, UI, or global Fx/Codex installation.

Run `pnpm verify`, stage the release, verify its payload, build the Debian package, and inspect the package before delivery. Live qualification must use the package on an authorized Debian host, must not create a VM or provider turn, and must preserve user state and `Linger=no`.

Runtime payloads are pinned in `vendor/manifest.json`. Never substitute a globally installed command, mutable branch, or unverified download. Engine updates require provenance, licenses, executable hashes, deterministic compatibility checks, and a new qualification receipt.

Keep `README.md` to the exact canonical first line, one pitch sentence, and minimum install commands. Put all technical and operational detail in owned documentation.
