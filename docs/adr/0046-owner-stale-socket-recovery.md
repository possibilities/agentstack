# 46. Recover only the owner's proven-stale socket at startup

Status: accepted, 2026-09-25. Narrowly qualifies the operator-only stale-socket cleanup in [ADR 0002](0002-private-control-transport.md); Package API socket servers still refuse existing paths.

A hard stop can leave `owner.sock` behind after the owner has exited. Before binding the owner socket, `agentstack serve` takes an exclusive startup-directory claim, checks that the old path is a socket, verifies a connection is refused, and checks its identity again before removing it. It holds the claim through the bind so two owner startups cannot both recover the same path. A listening socket, another file type, an ambiguous connection failure, or an occupied claim remains an error for the operator to inspect. If a process is killed during this short claim window, the claim may itself need manual inspection; never remove it or another Package API socket merely because startup failed.

This exception applies only to the owner command. It does not license probe-and-unlink on ordinary Package API sockets or override fixed-port preflight checks. The state directory is trusted to one OS user; processes of that same user acting outside the owner command can still race it.
