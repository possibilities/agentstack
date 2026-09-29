# Access setup, pairing and recovery

Access controls remote Brain sharing, Content reads and scoped remote UI sessions. Local same-user control
continues to use private sockets and the existing loopback UI. No listener here
exposes internal MCP, Bot identity or Worker identity to a device.

## Server configuration

Keep the Brain and Content backend hosts at `127.0.0.1`. Remote backend binds now
fail startup instead of exposing unauthenticated data.

Configure these in the server's environment before a separately authorized restart:

```sh
STACK_ACCESS_HOST=100.x.y.z
STACK_ACCESS_PORT=8943
STACK_ACCESS_ARTIFACT_PORT=8944
# Optional: enable a distinct, authenticated remote UI origin. Existing
# Access Brain/Content device ingress runs without these two settings.
STACK_ACCESS_UI_PORT=8945
STACK_ACCESS_UI_ORIGIN=https://machine.example-tailnet.ts.net:8945
STACK_ACCESS_TLS_CERT=/operator/provisioned/server.crt
STACK_ACCESS_TLS_KEY=/operator/provisioned/server.key
# Optional absolute CLI path, especially for GUI/launch-agent environments:
STACK_TAILSCALE_BIN=/usr/local/bin/tailscale
# Prefer direct daemon IPC when this installation exposes a Unix LocalAPI socket:
# STACK_TAILSCALE_SOCKET=/path/to/tailscaled.sock
```

The bind is the machine's actual Tailscale IP, not `0.0.0.0`, loopback, or a
hostname. The remote UI origin must be an exact HTTPS origin on its own port,
using the certificate's hostname resolving to that address. The Content origins
use the same certificate hostname on ports 8943 and 8944. A DNS
suffix is not an authorization signal. Certificate issuance/renewal remains the
operator's responsibility; Access reads the files at startup. Omitting
`STACK_ACCESS_HOST` disables remote listeners while local inventory works.

This implementation uses **direct** ingress. It does not support Serve/Funnel or
a reverse proxy: their loopback source fails provenance checks, regardless of
headers. It invokes read-only `tailscale status --json` and `tailscale whois
--json --proto=tcp <actual-source-ip:port>` on every request, with bounded timeout
and concurrent verification. With `STACK_TAILSCALE_SOCKET`, the same checks
use bounded read-only LocalAPI requests without spawning CLI processes.
No command changes Tailscale configuration.
Both peers must have working tailnet connectivity. Invalid or unavailable
evidence refuses pairing, refresh, preflight, document, UI and asset requests alike.

## Pair a plain browser for the remote UI

1. From a tailnet browser open the configured UI origin's `/connect`, e.g.
   `https://machine.example-tailnet.ts.net:8945/connect`. Check the TLS certificate.
   Enter a label and request approval. The page saves its 256-bit redemption
   secret in that origin's local storage **before** sending the request; do not
   clear site data while pairing is pending.
2. On the Stack machine, use the **local** System → Access window to compare
   the full code and approve a subset of `ui:view`, `ui:control` and
   `content:read`. The remote UI can never approve, update or revoke grants.
3. On the browser select **Approved? Connect**. The browser receives short-lived
   Secure, HttpOnly, SameSite=Strict, host-only UI and refresh cookies. It no
   longer stores the redemption/refresh credential in JavaScript storage. The
   UI session lasts five minutes and refreshes by rotation with a sliding
   15-minute refresh cookie; the underlying credential expires absolutely after 30 days.
   Reopen `/connect` if the session expires; if recovery is unavailable, re-pair.

`ui:view` admits read-only operations and event subscriptions selected by the
live WebSocket manifest. `ui:control` adds only operations used by UI. Both
are intersected with the package selection, and `ui:control` alone does not
admit a browser without `ui:view`. Access control operations, account sign-in
and credential flows (`auth`), voice calls, and headful browser handoff (`browse`)
are local-only even with control. The remote page's Next server render never
uses trusted-local socket snapshots. Grant narrowing or revocation closes an
open remote WebSocket immediately; subsequent requests fail. Access records
session admission and remote mutation receipts in its local audit.

Remote Content Preview and Artifacts require `content:read` in addition to
`ui:view`. Clicking Open POSTs to the UI origin as the current browser
principal, then opens a one-use handoff fragment on the separate Content origin
for **exactly one** document, item or immutable Artifact version. The old
Content one-use exchange, 60-second handoff, 15-minute resource-scoped session
and Artifact sandbox remain in force. A refused handoff shows an error rather
than opening an unauthenticated local link. Loopback Preview remains unchanged.

## Pair and approve

1. In Chrome or Android settings enter the HTTPS Access URL and select **Pair**.
   Chrome requests host permission for that exact origin. The connection is
   Stack-wide; current requested scopes are Brain admission, own share
   status and Content read.
2. In the server's UI, open **System → Access**. Compare the full displayed code
   with the device, then approve that matching request. Labels are device claims,
   not proof of identity. Requests expire after ten minutes.
3. On the device select **Check approval**. The device redeems with its separate
   secret, retained locally before the request. The human code is never a token.
4. Share normally. **Held** still means no confirmed Brain admission.

Local automation can use the same operations through the Unix socket. From the
repository root, this prints the current inventory without secrets:

```sh
node --input-type=module -e '
  import {socketCall,socketPath} from "./packages/api/dist/src/index.js";
  console.log(JSON.stringify(await socketCall(socketPath("access"), "tools/call", {
    name:"access_snapshot", arguments:{}
  }),null,2));'
```

For approval replace `name` with `pairing_decide` and `arguments` with
`{id:"<pairing UUID>",code:"<full code>",approve:true}`. Denial uses
`approve:false`. Revocation uses `access_revoke` with
`{kind:"credential",id:"<credential UUID>"}`; `client` and `grant` revoke their
dependent credentials. These are trusted local operations, never ingress routes.

Approval may supply `scopes:["brain:share"]` (or any subset of the requested
`brain:share`, `brain:status`, `content:read`, `ui:view`, `ui:control` scopes); omission approves the full
requested set. An exact approval replay must select the same scopes. Use
`grant_update` with `{id,expectedRevision,scopes,operations}` to replace policy.
Tailnet grants accept scopes and an empty operations array; cloud grants accept
operations and an empty scopes array. Narrowing affects existing access tokens,
outstanding handoffs and browser sessions on their next request.

## Wire and token lifecycle

The live `docs_snapshot` reference describes request/response schemas.

| Route | Authority |
| --- | --- |
| `GET /v1/access/identity` | Verified tailnet; stable server UUID only, no bearer needed |
| `POST /v1/access/pair` | Verified tailnet; UUID request ID and client-generated 32-byte base64url redemption secret, label, kind and explicit scopes |
| `POST /v1/access/redeem` | Verified tailnet; pairing ID and redemption secret |
| `POST /v1/access/refresh` | Verified tailnet; refresh token, persisted UUID request ID, `brain` or `content` audience |
| `POST /v1/share` | Brain audience token and `brain:share` |
| `GET /v1/shares?job_ids=…` | Brain audience token, `brain:status`, and durable admission receipts for those IDs |
| `GET /v1/health` | Brain audience token and `brain:status` |
| `GET /v1/access/me` | Brain audience token; no data scope required; returns `serverId`, `clientId`, `credentialId`, `scopes` |
| `POST /v1/content/handoff` (document origin) | Content audience token and `content:read` |
| `POST /v1/access/disconnect` | Brain audience token; no data scope required; revokes this credential |

On the separate UI origin `/connect/pair` and `/connect/redeem` use the same
locally approved browser pairing, `/connect/session` and `/connect/refresh`
rotate credentials into cookies, `/connect/me` reads live scopes, and
`POST /v1/content/handoff` uses the viewer's cookie rather than a Content
audience bearer. `/`, `/<space>`, `/_next/*` and `/websocket` require a live UI session;
all unsafe HTTP requests and WebSocket upgrades require the exact UI Origin.
No UI route forwards the internal MCP listener. See [ADR 0101](adr/0101-remote-uix-through-access.md).

The pairing receipt, redemption and refresh responses include the durable UUID
`serverId`. Pin it with the connection: all `/v1/` requests except initial pairing,
identity discovery and CORS preflight require `X-Stack-Server-ID` with that value. This includes
redemption, data, refresh, me, disconnect and handoff issuance. Missing or wrong
identity fails with `server_identity_mismatch` before admission or rotation.
Bearer-authenticated static Content reads require it too. Extension CORS allows
the header. Forwarded and Tailscale identity headers are refused, never trusted.
Browser navigation cannot set a custom header; its one-use secret and scoped
view session are already bound to the issuing server and origin.

HTTPS authenticates the host. The server UUID prevents accidental instance
replacement and destination changes; it is not a cryptographic host certificate.

For sharing, Access overrides `payload.client` from the approved client kind:
`chrome` becomes `chrome-extension`, `android` becomes `android-share`. A
`browser` client cannot submit shares even if granted `brain:share`.

Token and pairing successes use `{schema_version:1,ok:true,data:…}`; errors use
`{schema_version:1,ok:false,error:{code,message}}`. Secrets are opaque; never put
them in query parameters, logs, screenshots or the UI. Access tokens last five
minutes; refresh credentials have a 30-day absolute lifetime. The same refresh
retry ID recovers an ambiguous exchange for five minutes. After that, re-pair
and revoke the stranded credential from System. Do not blindly start a new
refresh request with the old token. Chrome serializes exchanges in its service
worker; Android serializes them around encrypted durable preferences.

Successful state transitions remove expired pairings, refresh recovery records,
access tokens, handoffs and sessions. Durable clients, grants, credential
metadata and admission receipts remain; the audit is bounded to roughly the
latest 1,000 entries, with the latest 100 exposed by the snapshot.

**Disconnect** confirms revocation before clearing the local credential. If the
server is unavailable, the client retains recovery information and reports the
failure. Use System to revoke a lost device. An expired/revoked credential
requires pairing again; held shares are preserved. Refresh failure must not
discard content or retarget its destination.

## Content browser handoffs

An authenticated client POSTs `{origin:"documents",path:"/d/example-slug"}` or
`{origin:"artifacts",path:"/a/name/v/<64-character-version>/"}` (or one `/c/<UUID>`)
to `/v1/content/handoff`. Open `/session#<handoff>` on the selected Access origin:
document port 8943 or artifact port 8944. Never place a refresh/access token in
that URL. The one-use handoff expires after 60 seconds. A lost exchange response
requires a fresh handoff. A document uses a Secure HttpOnly cookie covering only
that document for 15 minutes. An artifact uses `/view/<view-credential>/<resource>`
for the same lifetime, covering only one item or immutable bundle. Relative
scripts, styles and images retain that prefix; root-relative links require a new
handoff. Every view request still verifies tailnet and current grant/revocation.

The artifact URL is a narrow bearer viewing credential, not a pairing or refresh
credential. Anyone on the permitted tailnet holding it can view that resource
until expiry or revocation; it is not an anonymous public-sharing feature.
Do not log view URLs. Responses use `no-store` and `Referrer-Policy: no-referrer`.
This path-based view is necessary because an opaque sandbox does not send
SameSite cookies with its asset requests. It avoids enabling third-party cookies
or removing the sandbox's origin isolation.

Artifact scripts run with opaque origin, no fetch, workers or frames. This
protects other resources even when the browser has several resource cookies.
Artifacts requiring fetch/storage need a later per-artifact-origin design; this
implementation fails closed rather than sharing broad browser authority.
Document links to another resource require another authorized handoff. Normal
authenticated API reads can send an audience bearer in the Authorization header.

## Shared-token migration

Old Brain token files are neither imported nor accepted. The legacy reveal and
rotate operations are removed; `brain_status.shareTokenFile` is
null. Old Content remote binds must be removed. Chrome's old token preferences
and Android's old encrypted share preferences are not read as new credentials.
Existing outboxes/history remain intact and retain their original URL bindings.
They do **not** automatically follow the new Access URL; reconcile old held
entries explicitly or drain them with the prior installation before migration.

No public-cloud listener is started. `cloud_grant_create` records explicit
`package.operation` selections for a separate network policy and returns
`credentialIssued:false`. Hosted Grok/Claude connector OAuth, OAuth metadata and
remote MCP request admission remain deferred. Device tokens cannot become cloud
tokens, and the internal MCP listener must never be externally forwarded.
`grant_evaluate_operation` provides a trusted-local reusable policy check over
`{grantId,network,operation}` and returns `{allowed,grantId,operation}`. The
caller must already have authenticated that grant identity and independently
verified its network; an allowed result is not itself a credential. Unselected
operations, tailnet grants and revoked grants/clients are denied.
