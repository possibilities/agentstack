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

The client UI uses `LocalAuth` with `STACK_STATE_DIR` set to **the client root**.
Its parent mints `client_ui_connect`; a same-origin `/connect/local` exchange
installs the normal host-only HttpOnly local UI cookie. Gate every host page and
mutating route, require exact Host/Origin, use nonce CSP and never expose the
private socket as an anonymous HTTP bridge. This authority is independent of a
platform's local UI cookie and Access's remote cookies.

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

No release artifacts, npm package publication or default public release channel
are supplied by this phase. All existing workspace packages, including the new
client, are currently private. The standalone UI phase must supply a verified
distribution build and publishable dependency closure before `npx` works on a
fresh machine. No DMG/deb is required, but packaging-independent does not mean
artifact-independent. Initial local runtime targets are macOS arm64 and Debian
x64; supporting other targets needs matching codexnk releases/installer support,
not a vendor-runtime fallback. Missing prerequisites are surfaced, not installed
with sudo/brew/apt or signed in automatically.

## Remote connections and phone-mediated enrollment

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
