# Desk navigation adapter boundary

The future `packages/desk` shell reuses the Client host and authenticated Client
UI; it does not rewrite Canvas or expose a generic native command bridge. The
browser adapter in `packages/ui/bin/navigation.mjs` is the current implementation.
`packages/desk` is not implemented or started by this contract. See
[ADR 0152](adr/0152-independent-client-bootstrap-and-ui-handoffs.md),
[Client bootstrap](client-bootstrap.md) and [UI packaging](client-ui-packaging.md).

## Adapter contract

```ts
interface NavigationAdapter {
  openClientSurface(url: string): Promise<void>;
  openPlatform(input: {
    url: string;
    expectedOrigin: string;
    serverId?: string;
  }): Promise<void>;
  focusConnections(): Promise<void>;
  openExternal(url: string): Promise<void>;
}
```

- `openClientSurface` accepts only the launcher-established exact loopback Client
  origin. The parent mints and passes the one-use fragment URL directly; neither
  logs nor adapter errors may reveal it. Only this packaged, authenticated Client
  surface may receive a narrowly scoped future native bridge.
- `openPlatform` follows a **deliberate destination selection** and pins the
  supplied exact UI origin (scheme, host and port). `serverId`, when supplied,
  identifies the selected platform; it does not authorize accepting another
  origin or a changed descriptor. The URL contains a one-use local/Access viewer
  handoff, never a native refresh/access credential. Open a separate platform
  surface, not an iframe inside the Client.
- `focusConnections` focuses the independent Client surface at `/client` without
  minting another capability or changing the selected platform's authority.
- `openExternal` is reserved for an explicit human action opening an HTTP(S)
  URL in the system browser. It is not a fallback for a rejected redirect,
  TLS error, unknown destination or failed platform navigation.

All URL inputs reject credentials and non-HTTP(S) schemes. Exact-origin
allowlisting is per explicit Client/platform selection, not a tailnet-wide,
subdomain, wildcard, pathname-prefix or global navigation allowance. Remote
platforms use their pinned direct-tailnet HTTPS UI origin. Local platform UI uses
its independently authenticated loopback origin.

## Native shell enforcement

The later shell must enforce the policy on initial navigation **and every**
redirect, frame/popup, new-window and subsequent navigation event. Deny unexpected
origins, scheme changes, file/data/javascript URLs and bridge inheritance before
loading them. Do not silently update a pin from a page or certificate. Preserve
TLS verification errors; never ignore certificate errors, downgrade HTTPS,
proxy through a trusted local origin or automatically open the system browser.

Local and remote **platform pages get no native bridge**, including installation,
service/login controls or Client credentials. Content/artifact/external pages get
none either. A selected platform's normal scoped WebSocket/Access policy remains
authoritative. Navigation success is not readiness, pairing approval, operation
completion or permission to retry a consumed/expired handoff. Return to Client
Connections for a fresh deliberate Open or the host's exact pending-open receipt.

Native Access credentials stay in the Client host; WebViews receive only their
own independent HttpOnly viewer sessions. Surface closure must not stop a
platform, forget connections, revoke grants or register login behavior implicitly.
The adapter promises only navigation admission, not a completed page load.
Failures must be capability-safe (the browser implementation uses
`navigation_destination_refused` / `navigation_open_failed`), with TLS errors
truthfully represented by the native surface without echoing secret URLs.

## Bridge bounds and remaining desk work

Native SDK system WebViews default to WKWebView/WebKitGTK. Before implementation,
consult the then-current SDK contract; the present bridge has approximately
**12 KiB handler-result / 16 KiB response** limits. Account for JSON/envelope
overhead in UTF-8 bytes, not character count. Do not pass entire Client/private
socket snapshots, QR matrices or model catalogs blindly through `invoke`.

Use schema-validated, bounded results or a reviewed chunk/encoded adapter with
bounded total size, sequence/identity checks and cancellation. Keep the existing
authenticated HTTP RPC/SSE path where possible; chunking is not permission to
relax schemas, expose secrets or create an arbitrary socket/command tunnel.

`packages/desk` still needs native packaging/signing, host and UI supervision,
exact-origin navigation delegates, a trusted-client-only bridge and bounded data
adapter, certificate/error handling, explicit system-browser routing and tests
for redirects/popups/cross-origin bridge denial on both native WebView engines.
Native app login, OS keystore adapters and installer/update policy are separate
decisions; none are implied by the Client UI tarball.
