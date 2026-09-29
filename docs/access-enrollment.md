# QR enrollment protocol and client integration

Access enrolls Stack clients with independent credentials. Brain sharing is one use of those credentials. Manual pairing still works. This document describes the APIs; Android scanning, Chrome QR screens and local invitation UI are not implemented yet.

## Configure the advertised device destination

In addition to the direct-tailnet listener and TLS settings in [Access setup](access.md), set:

```sh
STACK_ACCESS_ORIGIN=https://machine.example-tailnet.ts.net:8943
```

This is the **device/document** origin, not the remote UI or Artifact origin. Its port must match `STACK_ACCESS_PORT` (default 8943). It must be an exact HTTPS origin with no userinfo, path, query or fragment, and cannot be loopback. If omitted, an existing `STACK_ACCESS_UI_ORIGIN` supplies its hostname with the configured device port. Without either, enrollment returns `enrollment_origin_not_configured`; manual pairing remains available. Startup validates an explicitly configured origin. TLS certificate provisioning, DNS and renewal remain operator-owned.

Changing configuration requires the normal authorized server restart. This feature never runs Serve/Funnel or alters the tailnet.

## The two flows

### A. First phone from trusted local control

1. The local caller persists `{requestId, secret, kind, scopes, expiresAt}`. Generate the secret from **32 random bytes**, encode canonical unpadded base64url (43 characters), and use a random UUID. Expiry must be in the next ten minutes. For a phone choose `kind:"android"`; select scopes such as `brain:share`, `brain:status`, `content:read`, and explicitly `access:enroll` if it should induct devices.
2. Call `enrollment_invite_create` over the trusted local Package API. It returns `{invitation, qr}`. Display the QR privately, alongside destination, permissions and expiry. Retrying the exact saved input returns the same invitation; changed inputs under the same UUID conflict.
3. The phone parses the scan as data, shows the destination and permission selection, and creates/persists its own enrollment intent, including a separate random redemption secret and ephemeral Ed25519 private key. Its kind must match the invitation and its requested scopes must be a nonempty subset of the invitation's scopes.
4. After explicit confirmation, check `GET /v1/access/identity` over HTTPS and compare the invitation's `serverId`. Then POST the invitation ID, invitation secret and request QR to `/v1/access/enrollment/claim`.
5. Persist the returned receipt, validate it against the intent and invitation destination, then POST `/v1/access/enrollment/redeem` with the phone's secret and signed proof. Persist the credential before discarding the intent and invitation. The phone now uses ordinary refresh/audience tokens.

An invitation is a one-use capability. Whoever captures it can race to claim its allowed authority until expiry. Deliver it only to the intended device and revoke it if exposed. The phone's private redemption secret is **different** from the invitation secret. Claim retries recover only for the identical request; they cannot choose a different commitment, label, kind or scopes.

### B. Blank extension/desktop through a paired phone

1. The new device needs no URL or credential. Generate and durably save a fresh intent; display its **request** QR. Show label, requested permissions, expiry and a fingerprint (the first 16 hex characters of the full request hash, grouped for reading).
2. The phone scans and strictly parses it, using only the phone's already-pinned Stack destination. Never navigate scanned strings or send phone credentials to addresses from QR data.
3. Refresh for audience `access`. POST `/v1/access/enrollment/inspect` with the request QR and the phone's access-audience bearer. The result gives the parsed request, full request hash and `allowedScopes`.
4. Show the claimed device label/kind, fingerprint and eligible permissions. Compare the fingerprint with the device. **Only explicit approval** POSTs `/v1/access/enrollment/approve` with a nonempty selected subset. Scanning or inspecting alone does not approve.
5. The phone receives a credential-free receipt. Return its QR/text to the new device via a trusted scan or paste. A browser extension without a camera can accept pasted receipt text. There is no automatic public relay.
6. The new device validates that the receipt belongs to its saved request and confirms the returned server destination. Persist the receipt, check HTTPS and installation identity, then redeem directly with its private secret and destination-bound Ed25519 proof. The phone cannot redeem it. The private signing key never leaves the new device.

Labels are claims, not identities. QR proximity is not a cryptographic guarantee about the human operating a device. The request fingerprint ties the displayed request to what is being approved. The return channel establishes the initially unknown server destination; a structurally valid receipt alone is not proof that its server is trusted. The UUID fences accidental replacement, while TLS authenticates the host. In addition, signed redemption binds the destination: a phishing server receiving the secret and a signature made for its own origin cannot replay them at the legitimate server.

## API inventory

Local socket/authenticated local WebSocket operations:

| Operation | Purpose |
| --- | --- |
| `enrollment_invite_create` | Create/recover a scoped one-use invitation; returns sensitive invitation and QR |
| `enrollment_invite_revoke` | Revoke invitation and any unredeemed claim |
| `enrollment_inspect` | Parse/preview an offline request without approving |
| `enrollment_approve` | Locally approve selected requested scopes; return receipt and QR |
| `enrollment_cancel` | Cancel an unredeemed enrollment |
| `enrollment_qr_render` | Validate/render an unexpired version-1 payload to a module matrix |
| `access_snapshot` | Secret-free invitation/enrollment metadata and durable grant provenance |

Remote device-origin HTTP, always direct-tailnet TLS with `X-Stack-Server-ID` and exact configured Host:

| POST path under `/v1/access/enrollment/` | JSON body | Authority |
| --- | --- | --- |
| `claim` | `{inviteId,secret,request}` | Invitation capability; no bearer |
| `inspect` | `{request}` | Access-audience bearer + `access:enroll`, non-browser client |
| `approve` | `{request,scopes}` | Same; scopes requested and held, never `access:enroll` |
| `cancel` | `{id}` | Same; only the sponsoring credential's own unredeemed enrollment |
| `redeem` | `{id,redemptionSecret,requestHash,signature}` | Target's secret commitment plus destination-bound Ed25519 proof; no bearer |

`request` is the exact canonical QR **text**, not an object. `claim` and `approve` return `{receipt,qr}` inside the normal `{schema_version:1,ok:true,data}` envelope. `inspect` returns `{request,requestHash,allowedScopes}`. `redeem` returns the existing credential receipt shape: `{clientId,credentialId,refreshToken,expiresAt,serverId}`. Errors use `{schema_version:1,ok:false,error:{code,message}}`. Live schemas are in `docs_snapshot`.

Refresh uses the existing `/v1/access/refresh` endpoint with `audience:"access"`. Brain, Content and UI tokens are not accepted as enrollment bearer tokens. Existing clients receive **no automatic enrollment permission**. Local control can explicitly update a paired phone's grant with `access:enroll`; no re-pair is required. `ui:control` never implies enrollment authority, and the remote UI continues to exclude Access operations.

## Portable TypeScript client

Exports:

- `@stack/access/enrollment-protocol`: strict schemas, lifetime, `encodeQr`, `decodeQr` and wire types.
- `@stack/access/enrollment-client`: Web Crypto intent generation, offline request fingerprinting, receipt validation, invitation claim, signed target redemption and sponsor inspect/approve/cancel. `signEnrollmentRedemption` supports clients with their own HTTP transport. This module has no Node, socket, camera or storage dependency. A secure context with Web Crypto Ed25519 is required; unavailable cryptography fails rather than weakening the proof.
- `@stack/access/qr`: local level-M encoder returning `{text,size,rows,quietZone:4}`. `rows` excludes the margin; each `1` is a black module. Render on white with four white modules on all sides and integer pixel sizing, independent of theme. Do not send payloads to online QR services.

Target flow (application storage and explicit human confirmation belong to the caller):

```ts
import { createEnrollmentIntent, encodeQr, enrollmentRequestHash, acceptEnrollmentReceipt,
  redeemEnrollment } from "@stack/access/enrollment-client";

const intent = await createEnrollmentIntent({
  kind: "chrome", label: "Work browser",
  scopes: ["brain:share", "brain:status", "content:read"],
});
await storage.saveIntent(intent); // BEFORE displaying or sending anything
const requestText = encodeQr(intent.request);
displayRequestQr(requestText, (await enrollmentRequestHash(requestText)).slice(0, 16));

const receiptText = await importReceiptFromPhone();
const receipt = await acceptEnrollmentReceipt(intent, receiptText);
await confirmDestination(receipt.origin, receipt.serverId, receipt.scopes);
await storage.saveReceipt(receiptText);
const credential = await redeemEnrollment(intent, receiptText);
await storage.saveConnection({ origin: receipt.origin, ...credential });
await storage.removeEnrollmentIntent();
```

Sponsor flow:

```ts
import { inspectEnrollmentRequest, approveEnrollmentRequest, encodeQr }
  from "@stack/access/enrollment-client";

// Obtain this token through the phone's serialized, persisted refresh machinery.
const sponsor = { origin: connection.origin, serverId: connection.serverId,
  accessToken: await accessTokenForAudience("access") };
const preview = await inspectEnrollmentRequest(sponsor, scannedRequestText);
const selected = await reviewAndConfirm(preview);
await storage.saveApprovalIntent({ request: scannedRequestText, scopes: selected });
const receipt = await approveEnrollmentRequest(sponsor, scannedRequestText, selected);
await storage.saveApprovalReceipt(receipt);
displayReturnQrOrCopyText(encodeQr(receipt));
```

The helpers never persist data for the caller and never silently retry mutations. Supply an optional `fetch` adapter if needed. They refuse redirects, use bounded timeouts, omit ambient cookies and preflight the pinned installation identity before sending secrets or bearer tokens. Persist *exact* intents/receipts and repeat them after an ambiguous response. Serialize refreshes using the existing connection machinery. An expired token can be refreshed without changing the approved request or chosen scopes.

## Cross-language wire format

Text is ASCII:

```
stack-access://v1/<request|invite|receipt>#<unpadded-base64url-of-UTF8-JSON>
```

No padding, extra fields, duplicate scopes, alternate key order/whitespace, altered type prefix, unsupported version, expired time or lifetime more than ten minutes ahead is accepted. Parse and re-encode to check canonical equality. Do not perform URL navigation.

Canonical JSON key order (all fields required):

| Type | Keys in order |
| --- | --- |
| Request | `v, expiresAt, type, id, kind, label, scopes, commitment, publicKey` |
| Invitation | `v, expiresAt, type, id, serverId, origin, secret, kind, scopes` |
| Receipt | `v, expiresAt, type, id, serverId, origin, requestId, requestHash, scopes` |

Use compact JSON with literal UTF-8 Unicode and ordinary JSON string escaping, no unnecessary slash escapes. `v` is integer 1; `expiresAt` is an integer Unix timestamp in milliseconds. Scope arrays are unique and sorted lexicographically. Labels are trimmed and limited to 80 UTF-16 code units. IDs are UUIDs. Origins are canonical HTTPS origins (default `:443` omitted). Secrets are canonical unpadded base64url of exactly 32 random bytes. `commitment` is lowercase SHA-256 hex of the **UTF-8 secret string**, not the decoded secret bytes. `requestHash` is lowercase SHA-256 hex of the **entire canonical request QR text**. A receipt's expiry cannot exceed the request expiry and its scopes must be a nonempty subset of the request.

`publicKey` is canonical unpadded base64url of the 32-byte raw Ed25519 public key.
The TypeScript intent stores its private key as canonical unpadded base64url of
the 48-byte PKCS#8 encoding (RFC 8410); native apps may store an equivalent key
in their protected keystore. The request secret and signing key must be generated
independently. The redemption signature is ordinary Ed25519 (not Ed25519ph),
64 bytes encoded as canonical unpadded base64url (86 characters), over these
UTF-8 lines, with **no final newline**:

```text
stack-access-enrollment-redeem-v1
<receipt.origin>
<receipt.serverId>
<receipt.id>
<receipt.requestHash>
<request.commitment>
```

Access reconstructs that message from its own stored enrollment and server
identity. Do not accept a caller-supplied proof message or origin. The private
key is enrollment-only; after durable credential installation it can be discarded
with the intent. Existing bearer/refresh credentials remain the steady-state API.

The wire is capped at 2,048 ASCII characters; enrollment HTTP bodies at 8 KiB. Keep device clocks synchronized. Clients should create new intents only when starting a genuinely new enrollment, never mutate/reuse a request UUID for different policy.

### Interoperability vector (test data only)

For the public test secret `A` repeated 43 times, the commitment is
`0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a`.
The canonical JSON below must produce request hash
`56fa2dbb8e48dc1619ddbd89f98e49c68ec4d5d1c844dee277b0edb0187406be` after
base64url encoding and adding the `stack-access://v1/request#` prefix:

```json
{"v":1,"expiresAt":1800000000000,"type":"request","id":"11111111-1111-4111-8111-111111111111","kind":"chrome","label":"Work browser","scopes":["brain:share","content:read"],"commitment":"0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a","publicKey":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}
```

Use test time `1799999900000` when exercising expiry with this vector. The
TypeScript suite verifies this independently generated vector and decodes the
rendered QR matrices with a separate QR decoder.

## Lifecycle, cancellation and recovery

- Invitation expiry, request expiry and sponsor credential expiry bound a pending enrollment; none exceeds ten minutes.
- Exact invite creation, claim and approval retries return the original result. Reused IDs with different secret commitments, kinds, labels, scopes, origin or sponsor return `request_conflict`.
- `inspect` is read-only. Approval creates no client credential until the target redeems. Rendering/returning a receipt does not establish an authenticated session.
- Sponsor credential/client/grant revocation, expiry or **any grant revision change** fences pending redemption. Start a new intent after authority changes; retrying an old approval cannot revive it.
- Cancellation and invitation revocation block unredeemed credentials. Redeemed credentials are independent; use trusted-local `access_revoke` to revoke them. Remote cancellation never becomes general client-administration authority.
- Exact redemption repeats recover the same refresh credential until enrollment expiry or its first refresh rotation. Thereafter the target must recover its persisted refresh intent using the existing five-minute retry protocol, or re-enroll and revoke a stranded credential locally.
- Pending capacity: 100 invitations, 100 enrollments globally, 10 enrollments per sponsoring credential. Capacity returns HTTP 429. Failed requests never partially consume an invitation or create a credential.
- `access_snapshot` exposes invitation expiry, claimed request ID, revocation; enrollment expiry, sponsor, invitation, credential ID and cancellation; and grant `enrollment_id`/`sponsor_credential_id`. No secret or QR capability appears there. Expired ephemeral records disappear on successful state transitions. An enrollment whose invitation/sponsor expired early retains its consumed request ID until the original request QR expires, so that QR cannot be recycled into another grant. Grant provenance is durable.
- Re-pairing cannot silently retarget Brain outboxes or held shares. Store the new connection independently until the user resolves any previous destination. Browser-kind credentials still require the separate `/connect/session` exchange to establish UI cookies.

Common errors: `invitation_invalid`, `invitation_used`, `invitation_policy_mismatch`, `invalid_enrollment_request`, `delegation_scope_refused`, `insufficient_scope`, `native_client_required`, `enrollment_authority_changed`, `enrollment_cancelled`, `enrollment_expired`, `enrollment_already_redeemed`, `enrollment_invalid`, `enrollment_proof_invalid`, `redemption_already_rotated`, `request_conflict`, `invitation_capacity`, `enrollment_capacity`. Network/identity/Host failures remain separate from approval status; never turn one into automatic approval or a new destination.
