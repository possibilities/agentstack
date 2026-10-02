# Client bootstrap and platform connections

The Client host in `packages/client` provides installation and connection APIs
before a Stack platform exists. It is not one of `serve`'s Package APIs.
`packages/ui` and the future `packages/desk` are its consumers; this contract does
not imply those interfaces or their distribution have shipped.

## Starting and reaching the host

```ts
import { startClientHost } from "@stack/client";

const host = await startClientHost({
  root: clientStateDirectory, // optional; default ~/.local/share/stack-client
  uiOrigin: "http://127.0.0.1:19000", // optional, exact independently served UI origin
});
const status = await host.call("client_snapshot", {});
const bootstrap = await host.call("client_ui_connect", {});
// Open bootstrap.url directly; never log this one-use secret.
// ...
await host.close(); // closes the host, NOT the managed platform service
```

`ClientInput<K>`, `ClientOutput<K>`, `clientInputs`, `clientOutputs` and
`clientDescriptions` are exported from `@stack/client/contract` (also the root).
`host.catalog()` contains the live JSON schemas. Native sidecars may run:

```sh
stack-client serve --ui-origin http://127.0.0.1:19000
stack-client call client_snapshot '{}'
```

`serve` emits only its private socket location. The socket is
`<STACK_CLIENT_STATE_DIR>/client.sock`. Use the shared `socketCall`/`socketSubscribe`
transport with `tools/list`, `tools/call` and `client_changed`. The notice contains
no payload; subscribe then snapshot and resnapshot after reconnect. Private
storage and socket permissions fail closed. A second host cannot rotate the
first host's UI authority or mark its live jobs interrupted. A proven dead socket
is recoverable, but a stale startup lock requires operator inspection.

The client UI uses `LocalAuth` with an explicit `{STACK_STATE_DIR: clientRoot}`,
never a process-global platform-state override.
Its parent mints `client_ui_connect`; a same-origin `/connect/local` exchange
installs a host-only HttpOnly local UI cookie. Gate every host page and
mutating route, require exact Host/Origin, use nonce CSP and never expose the
private socket as an anonymous HTTP bridge. This authority is independent of a
platform's local UI cookie and Access's remote cookies.

### Standalone UI foundation

The private workspace's provisional `stack-ui` bin in `packages/ui` requires Node
24 or newer and a completed UI build. It starts the Client host in the parent,
supervises a loopback-only Next child, then opens the one-use bootstrap directly.
`--root` selects the independent client root; `--port` defaults to 19000.
`--no-open` leaves navigation to the parent integration. An occupied UI port or a
live/uncertain foreign Client host is refused, never adopted. Closing the launcher
closes only its UI child and Client host, not a platform user service.

The immutable server runtime mode is `STACK_UI_MODE=client|platform`, defaulting to
`platform`. Only the launcher supplies client-root/origin/ingress configuration.
Client mode redirects `/` to `/client`, disables Canvas and platform connect
controls, and guards page, RSC, asset and `/api/client/*` requests. Platform mode
keeps the existing Canvas/Access policy and `/client` only explains the independent
launcher; it does not read a Client host. This is not a new Canvas space.

Client cookies use `stack_client_ui_<root-hash>`; the platform retains
`stack_local_ui`. Names prevent overwrite on one loopback hostname, while the
independent authority database and exact origin prevent cross-root authorization.
All responses are no-store/no-referrer/nosniff. Client scripts use a fresh nonce
CSP, with self-only connections, no objects, frames or base changes. The shared
LocalAuth browser helpers accept a configured cookie name without changing their
platform/Inspector defaults.

The client-only ingress rejects exact-Host/Origin mismatches and all supplied
forwarding/internal authority headers **before Next**. Next synthesizes forwarding
headers itself, so a short-lived HMAC assertion binds the original method, target,
Host, Origin and cookie; proxy, server renders and handlers verify it and recheck
the client-root LocalAuth session. It is not browser authority and never replaces
the session. Unsafe requests require the exact Origin; reads refuse a supplied
mismatching Origin. Do not run the client mode through an unguarded `next start`.

`POST /api/client/rpc` accepts only `{operation,input}` from an explicit Client
contract allowlist, parses both input and output, and fixes `tools/call` and the
client socket server-side. `client_ui_connect` remains parent/private-socket only.
Errors with uncertain dispatch/results are not permission to replay. Authenticated
`GET /api/client/events` subscribes to payload-free `client_changed` before emitting
readiness; the browser then reads snapshot/list and rereads after reconnect. It
rechecks the live session before notices and every 250 ms, closing on expiry or
revocation. The Connections home retains last-good reads with loading/error state,
shows local and saved remote platforms as peers, pending intents and unresolved
jobs. Its manual and phone entry points review remote setup outside Canvas.

`bin/navigation.mjs` defines `openClientSurface`, destination-pinned `openPlatform`,
`focusConnections` and explicit `openExternal` for the later desk adapter. Platform
pages never receive a Client/native installation bridge. The private
[portable candidate build](client-ui-packaging.md) prepares standalone output
with the custom ingress and bundled runtime; it does not publish a public npx
distribution or platform release bundle. The maintained
[desk navigation contract](desk-navigation.md) is the later native-shell boundary.
Public release choices and the native shell remain separate milestones.

### Local platform workflow

`/client/local`, reached through **Run locally** on Connections, observes
prerequisites, reviews the install plan and separately admits Install, Start,
Stop and platform login changes. Readiness is explicitly an observed
`serve_status` answer, not successful admission or native service completion.
Closing the Client UI or launcher never stops the platform. Connections remains
available in the page header.

The launcher alone selects the reviewed descriptor:

```sh
stack-ui --release-manifest /absolute/reviewed-release.json
# Alternatively, set STACK_CLIENT_RELEASE_MANIFEST in the parent environment.
```

The bounded JSON file must satisfy `releaseSchema` (the descriptor below).
The parent validates it before starting a host and pins its value for that UI
child's lifetime. HTTP Install and Plan use only that value and refuse absent or
changed browser descriptors. No platform descriptor, URL entry or browser
storage can select a release. Without configuration the page says **No trusted
release configured for this Client** and install is unavailable. A configured
descriptor is not a claim that a published release exists.

Prerequisites describe only observed OS/architecture, executable availability
and user-service availability; they do not prove Debian qualification or GitHub
authentication. Reviewed plans disclose paths, hashes, byte limits, requirements
and the shared codexnk runtime effect. Jobs show actual stages without fabricated
percentages.

Install/Start/Stop/Login persist a UUID and immutable input in a client-root-scoped
browser recovery slot before dispatch. Storage failure blocks dispatch. Reload
inspects but never dispatches; unresolved admission offers an identical retry
only after inspection. Known jobs are inspected, not rerun; unknown outcomes
require inspection and explicit acknowledgement before another new request.
Local Open has no request UUID, retains no sensitive URL and offers a fresh
deliberate Open if navigation/admission is uncertain. It opens a separate page,
never an iframe or an installation bridge on a platform page.

Only unresolved local Start/Stop receive bounded one-second observation polling
(up to 30 reads within 30 seconds); no action is retried. If still unresolved, explicit inspection
remains available. Platform login shows saved and applied values separately,
defaults off and does not imply permission to restart or future native-app login.
Local server setup preserves omitted defaults, binds `expectedRevision`, retains
conflicted drafts and applies on next start. TLS files, joining Tailscale and ACLs
remain operator-provisioned; no cert/Serve/Funnel/sudo convenience runs here.

## Local platform APIs

| Operation | Contract |
| --- | --- |
| `client_snapshot` | Installation, observed service/readiness, saved/applied login preference, saved/pending configuration, secret-free connections/intents and recent jobs |
| `client_prerequisites` | Supported local target, Node, python3, gh and observed user-service availability; installs and signs in to nothing |
| `client_install_plan` | Validate a caller-confirmed release and preview effects without downloading |
| `client_install` | Durable asynchronous admission using `requestId` and the exact release descriptor |
| `client_job_get` | Exact job: running/completed/failed/unknown, bounded stage and sanitized error |
| `client_platform_start` | Start only this host's owned user service; admission is not readiness |
| `client_platform_stop` | Stop the owned service through its service manager; no PID from disk is signalled |
| `client_login_set` | Save explicit enabled/disabled and apply without starting/restarting the platform |
| `client_platform_configure` | Revisioned replace of explicit ports and optional Access config; load on next start |
| `client_local_open` | Ready platform's existing socket-only `serve_local_connect`; sensitive one-use URL |
| `client_ui_connect` | Bootstrap the separately hosted client UI before platform installation |

Installation/start/stop/login return `{job,duplicate}` immediately. Persist a UUID
before calling and re-use the identical input after an ambiguous admission.
Changed inputs conflict; a duplicate never repeats an action. Read the job and
snapshot to distinguish admission, native command completion and platform
readiness. An interrupted host marks unfinished jobs unknown and does not replay
them. Installation failures after runtime installation begins may have affected
the shared runtime and are also unknown. Inspect current state before issuing a
new explicit request. Closing a UI or Client host does not stop the platform.

The local platform's state is `<client-root>/platform/state`, not the ambient
`STACK_STATE_DIR`. Its service name includes a hash of the client root. Definition
hashes fence unrelated edits. Mac uses `~/Library/LaunchAgents`; Debian uses
`~/.config/systemd/user`, `systemctl --user` and an existing user session. Login
does not mean machine boot; no systemd lingering is enabled. Mac live service
configuration can stay pending until an explicit stop followed by start. Saved
configuration stays pending until the corresponding definition is loaded by an
explicit start; changing login registration alone does not apply a running
process's environment. A matching file hash is insufficient if the service
manager reports a different registered definition. Local
platform login and future native **UI app** login are distinct preferences.

Configuration takes `{expectedRevision,configuration}`. Revision starts at zero.
Optional `ports` keys are `ui`, `websocket`, `mcp`, `inspector`, `documents`,
`artifacts` and `brain`; absent keys use platform defaults. Optional `access`
requires a direct tailnet `host`, exact `deviceOrigin`, separate `artifactPort`,
exact `uiOrigin`, and absolute `tlsCert`/`tlsKey` paths. Omit `access` to disable
remote ingress. Saving is not application. This API never joins a tailnet, runs
`tailscale cert`, edits ACLs, enables Serve/Funnel or opens a public listener.

## Release input and bundle layout

The caller supplies a reviewed descriptor, **not** a URL advertised by an
untrusted platform:

```ts
{
  version: "<release>", platform: "darwin" /* or linux */, architecture: "arm64" /* or x64 */,
  url: "https://<approved-release-origin>/<artifact>.tgz",
  sha256: "<64 lowercase hex characters>",
  bytes: 123456, unpackedBytes: 456789
}
```

The hash/size must come from the trusted client distribution's release selection,
not from the downloaded archive itself. Redirects, URL credentials/query strings,
hash/size mismatch, unsupported targets, unexpected archive entry types, links,
path traversal, duplicate paths and oversized expansion fail closed. Limits are
512 MiB compressed, 2 GiB declared payload and 100,000 entries. Tar padding and
metadata expansion are bounded separately.

The archive contains files/directories only, with no enclosing directory:

- `stack-release.json`: the exported `bundleSchema`: version, platform,
  architecture and exact `{codexnk:{tag,sha}}` required by Stack.
- `bin/stack`: self-contained executable supporting `serve`, locating all owned
  resources relative to its immutable bundle; it must not rely on npx's cache,
  a shell profile or a development checkout.
- Prebuilt platform packages, UI and dependencies, with any workspace links
  materialized safely, and a durable Node runtime needed by the launcher.
- `runtime/codexnk-install.py`: the compatible reviewed codexnk owner installer.
  It receives `--install --tag codexnk-v0.1.7 --sha
  3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c`. The consumer clears relocation and
  preserves `~/.local/libexec/codexnk/codex`. Pin advances remain coordinated with
  Stack's existing installer and AgentStart. This is consumption, not a fork patch.

Install is not startup. It never builds `.next` or registers a service. The shared
codexnk path can be updated by its authoritative installer; a running process is
not restarted. A local owned live service must first be explicitly stopped before
another platform release is selected. Old immutable releases and platform data
are retained; this version has no uninstall, rollback or garbage-collection API.

No published release artifacts, npm package publication or default public release
channel are supplied by this phase. All existing workspace packages, including
the client, are currently private. The UI can prepare a private, offline-installable
[candidate](client-ui-packaging.md); public ownership, publication and an actual
public npx check remain undecided. No DMG/deb is required, but packaging-independent does not mean
artifact-independent. Initial local runtime targets are macOS arm64 and Debian
x64; supporting other targets needs matching codexnk releases/installer support,
not a vendor-runtime fallback. Missing prerequisites are surfaced, not installed
with sudo/brew/apt or signed in automatically.

## Remote connections and phone-mediated enrollment

### Client UI workflows

`/client/manual` inspects an exact HTTPS device origin and requires confirmation
of the installation ID and every advertised origin before manual admission.
The permission picker requires `ui:view`, with optional `ui:control` and
`content:read`. The full selectable approval code and expiry stay visible;
**Approved? Connect** is deliberate, never an approval poll. Optional Tailnet
**peer** hints are read only on request and fill only the origin field.

`/client/phone` generates an offline request and renders the local module matrix
black on white, preserving the returned quiet zone in every theme. Full
fingerprint, requested permissions and expiry accompany it. Receipt paste is
always available; native QR camera decoding is optional and gesture-only.
The authenticated, read-only `/api/client/receipt` handler uses Access's canonical
`decodeQr` and request fingerprint to preview a matching receipt. It performs no
host mutation or network request. Runtime protocol schemas stay server-side under
the Client's nonce-only script CSP. Confirmation precedes receipt acceptance;
redemption is a separate deliberate action. Expiry never renews an intent.

`/client/connections/<id>` opens an exact destination in a separate tab through
the destination-pinned navigation adapter. UUID and exact input are persisted
before manual/enrollment admission and every Open dispatch, including retries,
under the Client root and destination (offline enrollment uses its own intent
identity until a destination is confirmed). Storage failure blocks dispatch.
Pending intent links inspect host-owned metadata; recovery never dispatches on
mount. A listed `pendingOpen` always wins and recovery uses that UUID.
Without a pending rotation, a consumed/expired handoff needs a new deliberate
Open, not re-pairing. Unknown answers stay frozen until inspection and an explicit
recovery decision. No capability URL or native credential enters browser storage.

Forget captures `expectedRevision` for explicit local removal. Conflicts reread
the record and require review/confirmation again, never automatic retries.
It is not remote revocation, secure erase or guaranteed viewer sign-out.
Changed identity/destinations require a new inspected connection; no relocation
or pending-open reset is invented. The five-minute native retry limit and
re-enroll/forget recovery are shown on unresolved Open details.

Pending enrollment metadata does not expose a saved receipt's destination, so
after reload the person must deliberately recover the same request QR and paste
the receipt again to review it before redemption. A lost enrollment-redemption
answer may need manual reconciliation against Connections: there is no public
intent-to-completed-connection lookup. Connection metadata also cannot establish
live scopes or grant status; owner refusals are reported without inferring them.

| Operation | Contract |
| --- | --- |
| `client_tailnet_peers` | Up to 200 local Tailscale peer hints, no remote probing or automatic pairing |
| `client_connection_inspect` | Credential-free exact HTTPS device-origin descriptor inspection |
| `client_pair_begin` | Persist a desktop secret, request manual local approval, recover the same receipt after loss |
| `client_pair_redeem` | Redeem approved request; store credential before dropping private intent material |
| `client_enrollment_begin` | Persist an offline desktop intent; return request text and full fingerprint |
| `client_qr_render` | Local Access QR module matrix; works without a platform |
| `client_enrollment_accept` | Validate/persist returned phone receipt; call only after destination confirmation |
| `client_enrollment_redeem` | Direct signed redemption with the desktop's own retained secret/key |
| `client_connection_list` | All saved connections plus secret-free pending intent/recovery metadata |
| `client_connection_open` | Serialized, persisted native credential rotation and scoped one-use UI handoff |
| `client_connection_forget` | Revisioned local removal, explicitly **not** remote revocation |
| `client_intent_forget` | Revisioned local abandonment; its UUID cannot silently create another intent |

Manual flow: inspect, explicitly confirm descriptor, persist a request UUID,
begin, compare the entire approval code on trusted-local Access, then redeem.
Phone flow: generate an offline request QR, have an existing sponsor phone
inspect and explicitly approve it at its own pinned platform, return the
credential-free receipt by QR/paste, confirm the platform destination, accept,
then redeem. Phone scopes must include `access:enroll` and each selected UI scope.
Read [the enrollment contract](access-enrollment.md) for sponsor APIs and proofs.
No scanning alone approves, no phone token is copied and no public relay exists.

An inspection reads `GET /v1/access/connection` over direct-tailnet TLS. It returns
`{version:1,serverId,deviceOrigin,documentOrigin,artifactOrigin,uiOrigin,pairing}`.
`uiOrigin` can be null: pairing is independent of UI availability. The configured
device Host and direct-peer provenance are enforced. Pinned descriptor changes
fail before credentials are sent; this first version requires deliberate new
connection enrollment rather than silently accepting a moved destination.

Connections are individually identified, even for the same platform. Client
snapshots contain no refresh token, access token, redemption secret or private
key. Up to 100 connections and 100 pending intents per kind are retained; explicit
forgetting frees capacity. Private client SQLite holds native secrets under mode
0600 in a mode-0700 directory; this is not an OS sandbox or a native keystore.
Local deletion is not a cryptographic erase of SQLite/WAL bytes. A future native
keystore adapter must preserve the same retry and destination invariants.

Opening refreshes for audience `ui`, persisting the exact old credential and
request ID first. An unknown rotation blocks a different open request; resume
the `pendingOpen` UUID, never guess another refresh generation. A successful open
returns `{url,expiresAt,serverId}`. Open it directly; do not record it in activity
logs, telemetry, history or error reporting. A repeated open UUID recovers the
same capability while it is valid; already consumed/expired navigation requires
a new **explicit** open action. Forgetting a connection neither revokes its server
credential nor signs out existing viewer cookies.

Native refresh recovery is bounded by Access's existing five-minute retry window.
An unresolved rotation beyond that window, or an expired token retained during an
unfinished open, currently requires deliberate new enrollment and local forgetting
of the stranded connection. There is no automatic re-pairing or pending-open reset.

## Access UI handoff wire

1. `POST /v1/access/refresh` now permits `audience:"ui"` as well as existing
   audiences. Native refresh credentials stay in the host.
2. `POST /v1/access/ui-handoff` with `{requestId}`, ui-audience bearer and pinned
   `X-Stack-Server-ID` returns the normal envelope containing a sensitive
   `https://<ui-origin>/connect/device#<one-use-capability>` URL.
3. The UI shell removes the fragment and POSTs `{handoff}` to its own
   `/connect/device`. Origin, provenance, credential, scope and mint-time grant
   revision are checked before consumption.
4. Exchange sets five-minute `__Host-stack_ui` and fifteen-minute
   `__Host-stack_ui_view_refresh` Secure, HttpOnly, SameSite=Strict cookies.
   `/connect/refresh` rotates this independent viewer family. It never consumes
   the native refresh credential. Identical old-cookie retries recover the same
   generation for five minutes; a superseded/expired generation cannot revive.
5. Existing UI HTTP, WebSocket scope/exposure intersection, immediate connection
   fencing, remote SSR isolation and resource-scoped Content handoffs remain in
   force. Desktop kind confers no trusted-local Access, auth, voice, Proc, Role
   shim or headful browser controls.

The current browser manual-pairing page and legacy refresh cookie still work.
Content handoffs are separate capabilities on separate origins. Neither platform
HTML nor Content is permitted to call native/client-host installation commands.

## Verification boundary

`pnpm test` covers cold installation, storage/retries, destination pinning,
manual/phone enrollment, client-root authority and Access viewer fencing with
disposable state. A macOS user-session integration check is opt-in:

```sh
pnpm exec turbo build --filter=@stack/client...
STACK_CLIENT_SERVICE_TEST=1 node --test packages/client/dist/test/service.test.js
```

It registers only a unique disposable label/home and an inert fixture process,
then verifies foreign-service refusal, explicit configuration application, host
closure and owned cleanup. This is not a real platform-release readiness test,
startup-after-login test or Debian/systemd integration result. Those require the
corresponding host/release and remain distribution acceptance checks.
