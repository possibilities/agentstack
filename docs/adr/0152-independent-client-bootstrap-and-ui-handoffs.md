# 152. Independent client bootstrap and scoped desktop UI handoffs

Status: accepted, 2026-09-30. Extends [ADR 0003](0003-required-codexnk-runtime.md),
[ADR 0101](0101-remote-uix-through-access.md), [ADR 0113](0113-authenticated-local-control.md)
and [ADR 0127](0127-qr-device-enrollment.md). Qualifies ADR 0101's browser-kind-only
UI sessions: desktop clients may now establish scoped viewer sessions through a
one-use handoff, not the legacy browser credential exchange.

## Decision

`packages/client` owns the same-user **Client host**, independent of `serve`.
It can exist before Stack is installed and survive a platform stop. Its typed
operations and payload-free `client_changed` notice use a private Unix socket.
It is not a Package API in the platform fleet, not a remote service and not an
MCP server. `packages/ui` will build the client interface first; the future
`packages/desk` Native SDK shell will consume these same contracts later.

A Client host owns one optional local platform and multiple independent remote
connections. Its root defaults to `~/.local/share/stack-client`, independently of
platform state. It uses private storage, exclusive socket ownership and durable
job/request receipts. Lost native outcomes remain unknown. Installation, start,
stop and platform login preference are separate explicit actions. A saved login
preference defaults to false and is distinct from application to an owned user
service. Neither configuration edits nor installation restart a live platform.

Installations use explicitly pinned HTTPS release bundles, checked for byte size,
SHA-256, target, manifest and bounded safe extraction. A new release directory is
published before selection; there is no source build under a running UI. Bundles
carry a self-contained Stack launcher, prebuilt UI/Node resources and the reviewed
codexnk owner's installer. The Client host invokes that installer with Stack's
required tag/SHA, preserving its absolute home-relative runtime and ownership
contract. It does not maintain another runtime downloader, carry an upstream
patch, select vendor Codex or expose a binary override. Installing can update the
**shared** codexnk installation; the installation plan states that effect. Python
and `gh` remain explicit prerequisites. This phase does not publish release
bundles or npm packages.

Local background operation uses an exact owned launchd user agent on macOS or a
systemd user service on Debian. No root, sudo, lingering, global service, arbitrary
PID signalling or adoption of another Stack process is permitted. Normal Stack
shutdown remains responsible for its children. Desired ports and optional Access
configuration are saved separately and load on a subsequent explicit start.
TLS provisioning and renewal, joining Tailscale and Tailscale policy remain
operator-owned. The reviewed runtime installer's initial local target matrix is
macOS arm64 and Debian x64; remote-only use does not require that runtime.

An optional exact loopback client-UI origin gets its own `LocalAuth` authority in
the **client root**, rotated only after host ownership is established. Private
`client_ui_connect` issues a single-use origin-bound bootstrap. It does not grant
platform authority. Future standalone UI routes must validate this separate
session before reading Client host state or forwarding any installation control.
No anonymous loopback installation listener is introduced.

Access advertises a versioned connection descriptor on its existing verified
direct-tailnet device origin. The human-selected HTTPS origin and stable server
ID are pinned before any secret is transmitted. A changed descriptor requires
explicit review; peer hints from local Tailscale status are never Stack discovery
proof, permission or automatic pairing. Manual pairing and the existing offline
request → explicit phone approval → credential-free receipt → signed desktop
redemption flows issue independent desktop credentials. The phone must hold
`access:enroll` and the UI scopes it sponsors; enrollment authority is never
delegated. No public relay or phone credential forwarding is introduced.

A ui-audience token with `ui:view` can mint a one-use, 60-second, exact-UI-origin
handoff for a desktop or browser client. Navigation carries only that capability
in a fragment. Its UI-origin shell erases the fragment before exchange. Native
refresh credentials never enter a page, cookie or URL. Exchange produces the
existing five-minute UI session plus an **independent** fifteen-minute rotating
viewer-refresh family; retries recover a generation without rotating the desktop
credential. Handoff issuance/consumption, viewer requests and viewer refresh
recheck live grants. Grant revisions fence pending handoffs, and existing scoped
WebSocket admission continues to close on grant changes and revocation.

Remote platform HTML never receives Client host/native installation authority.
The future shell must allow its native bridge only on its trusted client surface,
not on any local/remote platform page, Content origin or external page. The remote
UI's existing operation and event selection remains authoritative; desktop kind
does not elevate it to trusted-local control.

## Consequences

See [the maintained client contract](../client-bootstrap.md). Standalone UI,
public npm/release distribution and the Native SDK app are separate delivery
phases. A browser served only by an existing platform cannot install software on
the viewer's machine. The npx client must launch an independently authenticated
local UI host before offering installation. Packaging a DMG or Debian package is
not required for that path, but real pinned release artifacts and published npm
dependencies are. Existing platform-served UI and pairing remain operational.
