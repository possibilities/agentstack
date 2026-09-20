# 0001: One product service owns both engines

Status: accepted 2026-09-20; superseded 2026-09-20 by 0007.

AgentStack milestone one uses one OS-managed daemon that directly parents Fx ACP and Codex app-server. No core, broker, host, scheduler, UI, TCP server, or native engine daemon is introduced. The daemon owns pipes and process lifecycle; systemd owns daemon recovery and cgroup cleanup.

This is the smallest topology that proves product-owned engines and creates a stable seam for later clients without claiming conversation attachment or persistence.
