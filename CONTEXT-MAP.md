# Context map

| Area                    | Owner            | Contract                                                        |
| ----------------------- | ---------------- | --------------------------------------------------------------- |
| `apps/daemon`           | service process  | Direct child ownership and status assembly                      |
| `apps/cli`              | operator surface | User service lifecycle, status, logs, doctor                    |
| `packages/contracts`    | wire contract    | `agentstack.control.v1` schemas and enums                       |
| `packages/runtime`      | process boundary | paths, private socket, bounded framing, retries, shutdown       |
| `packages/engine-codex` | Codex protocol   | app-server initialize/initialized readiness only                |
| `vendor`                | release inputs   | pinned provenance, licenses and Linux payloads                  |
| `packaging/linux`       | Debian artifact  | filesystem layout and user unit                                 |
| `scripts/install-host`  | AgentStack       | exact public-release installation and qualification             |
| `docs/evidence`         | release proof    | compact redacted receipts, never credentials or provider bodies |
