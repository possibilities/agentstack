# Operations

Install and activate for the current logged-in user:

```sh
sudo apt install ./agentstack_0.1.1_amd64.deb
agentstack enable --now
agentstack status
```

The unit is session-scoped. `enable` targets this user's `default.target`; it never enables linger. If no user manager or D-Bus session exists, the CLI returns the `systemctl --user` error and does not fall back to a system service.

Useful commands:

```sh
agentstack status --json
agentstack child restart fx
agentstack logs --component fx --follow
agentstack doctor --json
agentstack restart
agentstack stop
```

Status exits are 0 healthy, 3 stopped, 4 degraded, and 5 incompatible or failed. Status is observational: it never starts a service, logs in, repairs paths, or runs inference. `runningVersion` can differ from `installedVersion`; stop the service before package upgrade, install the package, then start it so no process retains removed release files. Release staging and packaging derive every path and manifest identity from the selected product version, so N and N+1 artifacts can be built independently with one fixed `SOURCE_DATE_EPOCH` each. Reinstall and update never place user state under package-owned paths.

`Restart=on-failure` recovers an unexpected daemon exit. The daemon retries an unexpected child exit at 250 ms exponential backoff capped at 10 seconds, with five failures in 60 seconds. Authentication and protocol incompatibility remain observable without a restart storm. Intentional shutdown closes control admission, ends child input, sends SIGTERM, waits, and escalates owned children after the grace period. `KillMode=mixed` is the cgroup backstop.

`agentstack child restart` returns only after the daemon admits the operation. It does not claim terminal success; inspect `agentstack status` for the new generation and readiness. A lost response has unknown outcome and must be observed before retrying.

Removal preserves `$XDG_CONFIG_HOME/agentstack` and `$XDG_STATE_HOME/agentstack`. Stop and disable the user unit before removal. No package hook guesses desktop users or deletes their state.
