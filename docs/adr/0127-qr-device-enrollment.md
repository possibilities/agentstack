# 127. QR invitations and delegated device enrollment

Status: accepted, 2026-09-29. Extends [ADR 0091](0091-shared-access-and-direct-tailnet-ingress.md). The manual pairing protocol and [ADR 0101](0101-remote-uix-through-access.md)'s remote browser boundary remain available.

## Decision

Access owns version-1 QR **invitations**, offline device **requests**, and connection **receipts**. They serve Stack-wide clients, not Brain-specific identities. `desktop` joins `android`, `chrome` and `browser` as a client kind. The current desktop support is credential enrollment; it does not implement a desktop application or expand existing resource handlers' client-kind policies.

QR encoding is local, using a maintained QR encoder, level-M error correction and a four-module white quiet zone. The API returns a module matrix and exact text rather than executable SVG or an external image URL. Omajot inspired the consistent presentation and readable destination alongside the code; its Serve identity-header authorization is not adopted.

### First device

Trusted local control creates an expiring invitation with explicit kind and scopes. Its caller persists a random 256-bit invitation secret, request UUID and expiry before admission, so a lost response can be recovered without server-side plaintext secret storage. The invitation QR carries that short-lived capability, the configured device HTTPS origin and installation UUID. It is sensitive, unlike a request or receipt QR.

The phone creates and persists its own independent 256-bit redemption secret, ephemeral Ed25519 signing key and offline request. Scanning the invitation does not itself perform network work. After confirming the destination, the phone checks identity and claims the invitation over direct tailnet TLS. Claim atomically binds it to exactly one request. The phone redeems with its own secret and destination-bound signature to obtain its credential. Exact claim and redemption retries are supported; a different claimant, altered request, cancellation, expiry or revoked invitation cannot reuse it. Local control may include `access:enroll` to make the phone an enrollment sponsor.

### Induct another device without server setup

The extension or future desktop application creates its request entirely offline. Its QR contains a request UUID, client-kind and label claims, requested scopes, expiry, SHA-256 commitment to its private redemption secret, and an ephemeral Ed25519 public key. It contains neither the secret, private key nor a server address.

The paired phone parses the request as data and uses its own pinned server connection. With an **access-audience** token and `access:enroll`, it can inspect the request and then explicitly approve selected scopes. A scan or inspection never approves. The human should verify the request fingerprint on the intended device. The selected scopes must be both requested and held by the sponsor. `access:enroll` itself cannot be delegated, even when the phone holds it. Browser-kind clients cannot sponsor.

The server returns a credential-free connection receipt bound to the exact request hash, selected scopes, origin, installation UUID and enrollment ID. The phone transfers it back by QR scan or paste. This return channel is required: an offline device with no server address cannot poll an unknown server. No public rendezvous relay, phone-controlled callback URL, LAN listener or Tailscale reconfiguration is introduced.

The target validates the receipt against its retained request, confirms the returned destination, verifies HTTPS and server ID, and sends its secret directly to Access with an Ed25519 signature. The proof binds the exact origin, installation UUID, enrollment ID, request hash and secret commitment under a versioned domain separator. A substituted return destination cannot harvest proof usable at the real server, even if it captures the redemption secret. The private key never leaves the target; the phone never gets the target's secret or resulting credential. Both proof and commitment are verified inside the issuance transaction. Until redemption, the sponsor credential must remain active, its grant revision unchanged and its scopes sufficient. After successful redemption, the child is an independent Access client; parent revocation does not cascade to already issued credentials. Grant metadata permanently records the enrollment ID and sponsor credential ID so local inventory can locate and revoke those devices.

### Bounds and recovery

QR payloads use a strict canonical versioned format, at most 2,048 ASCII characters. Lifetimes are at most ten minutes; incorrect clocks fail closed. Invitation and approval policy are immutable per request. The server stores hashes of invitation and redemption secrets, and deterministically derives the first refresh token. Exact redemption retries work until expiry or first refresh rotation. Each issued credential then uses the existing 30-day absolute expiry, audience-token rotation, resource grants and revocation rules.

Each invitation is one-use; pending invitation/enrollment capacity is bounded, with a separate per-sponsor pending bound. Expired ephemeral rows are collected on successful transitions, retaining consumed request IDs until the original QR expires even if the invitation expired sooner. Long-lived grant provenance survives collection. Snapshot and audit never include invitation QR text, raw secrets, private keys or credentials.

All enrollment HTTP calls require actual direct-tailnet peer verification, a pinned server ID and the configured Host. They run only on the device/document origin; remote UI cookies, Content handoffs, proxy identity headers and internal MCP are not enrollment authority. `STACK_ACCESS_ORIGIN` explicitly advertises that device origin; absent it, a configured remote UI origin supplies the same hostname with the device port. Neither caller headers nor QR request data can choose the advertised destination.

## Delivery boundary

This decision delivers local Package API operations, remote HTTP operations, portable TypeScript client primitives, QR rendering and protocol documentation. Existing UI types, grant inspection and permission controls track the new metadata and scope. Android camera/approval, Chrome request-QR/receipt-import, and local invitation controls remain a separately requested client-UX implementation. See the [enrollment protocol](../access-enrollment.md).
