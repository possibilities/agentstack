import { z } from "zod";
import { connectionSchema } from "@stack/access/connection-client";
import { scopeSelection, originSchema, qrTextSchema } from "@stack/access/enrollment-protocol";
import { enrollmentReceiptSchema, qrRenderSchema } from "@stack/access/enrollment-protocol";

const id = z.uuid();
const request = { requestId: id };
const label = z.string().trim().min(1).max(80);
const path = z.string().min(1).max(4096).refine(value => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value), "Use an absolute path without control characters");
const port = z.number().int().min(1).max(65535);
export const platformConfigurationSchema = z.strictObject({
  ports: z.strictObject({ ui: port.optional(), websocket: port.optional(), mcp: port.optional(), inspector: port.optional(),
    documents: port.optional(), artifacts: port.optional(), brain: port.optional() }).optional(),
  access: z.strictObject({ host: z.string().refine(value => {
    const parts = value.split(".").map(Number);
    return /^\d+\.\d+\.\d+\.\d+$/.test(value) && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
      && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127 || /^fd7a:115c:a1e0:/i.test(value);
  }, "Use a direct Tailscale IP"), deviceOrigin: originSchema, artifactPort: port, uiOrigin: originSchema,
  tlsCert: path, tlsKey: path }).refine(value => new Set([Number(new URL(value.deviceOrigin).port || 443), value.artifactPort,
    Number(new URL(value.uiOrigin).port || 443)]).size === 3, "Access requires three distinct ports").optional(),
});
export type PlatformConfiguration = z.infer<typeof platformConfigurationSchema>;
export const releaseSchema = z.strictObject({
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  platform: z.enum(["darwin", "linux"]), architecture: z.enum(["arm64", "x64"]),
  url: z.string().url().refine(value => { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search; }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(536_870_912),
  unpackedBytes: z.number().int().positive().max(2_147_483_648),
});
export type Release = z.infer<typeof releaseSchema>;
export const bundleSchema = z.strictObject({ version: releaseSchema.shape.version, platform: releaseSchema.shape.platform,
  architecture: releaseSchema.shape.architecture, codexnk: z.strictObject({ tag: z.literal("codexnk-v0.1.7"),
    sha: z.literal("3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c") }) });

/** These are client-host operations, NOT remotely exposed platform Package APIs. */
export const clientInputs = {
  client_snapshot: z.strictObject({}),
  client_prerequisites: z.strictObject({}),
  client_qr_render: z.strictObject({ text: qrTextSchema }),
  client_job_get: z.strictObject({ id }),
  client_install_plan: z.strictObject({ release: releaseSchema }),
  client_install: z.strictObject({ ...request, release: releaseSchema }),
  client_platform_start: z.strictObject(request),
  client_platform_stop: z.strictObject(request),
  client_login_set: z.strictObject({ ...request, enabled: z.boolean() }),
  client_platform_configure: z.strictObject({ expectedRevision: z.number().int().nonnegative(), configuration: platformConfigurationSchema }),
  client_local_open: z.strictObject({}),
  client_ui_connect: z.strictObject({}),
  client_tailnet_peers: z.strictObject({}),
  client_connection_inspect: z.strictObject({ origin: originSchema }),
  client_pair_begin: z.strictObject({ ...request, label, connection: connectionSchema, scopes: scopeSelection }),
  client_pair_redeem: z.strictObject({ id }),
  client_enrollment_begin: z.strictObject({ ...request, label, scopes: scopeSelection }),
  client_enrollment_accept: z.strictObject({ id, receipt: qrTextSchema }),
  client_enrollment_redeem: z.strictObject({ id }),
  client_connection_list: z.strictObject({}),
  client_connection_open: z.strictObject({ id, ...request }),
  client_connection_forget: z.strictObject({ id, expectedRevision: z.number().int().positive() }),
  client_intent_forget: z.strictObject({ kind: z.enum(["pairing", "enrollment"]), id, expectedRevision: z.number().int().positive() }),
} as const;
export type ClientOperation = keyof typeof clientInputs;
export const clientDescriptions: Record<ClientOperation, string> = {
  client_snapshot: "Read local installation, background service, saved login preference, secret-free connection metadata and recent jobs. Does not install, start or discover remote servers.",
  client_prerequisites: "Observe local bootstrap prerequisites without installing, starting, signing in or importing configuration. Local platform release support is macOS arm64 and Debian x64 for the reviewed codexnk installer. Missing python3/gh or a user service session needs explicit operator setup; remote-only use does not install these dependencies.",
  client_qr_render: "Validate and render an unexpired Access request, invitation or receipt locally, even without a running platform. Returns the existing four-module quiet-zone matrix contract. Never navigate QR data or send it to an online encoder; invitation payloads are sensitive.",
  client_job_get: "Read one exact durable local job and its definite or unknown outcome; no raw process output or credentials.",
  client_install_plan: "Validate a pinned release for this macOS/Debian host and preview paths, bytes and effects. Downloads nothing; installing never starts or restarts Stack.",
  client_install: "Admit pinned-bundle installation; return a durable job immediately. Exact UUID retries recover; changed intents conflict. Calls codexnk's bundled release installer with the required tag/SHA at its owned home path. Needs python3/gh, never sudo, a workshop checkout, package-manager scripts, service start or live-directory rebuild.",
  client_platform_start: "Admit starting only this host's managed local platform as a user background service. Reuses its exact owned service; never adopts another running Stack or signals a PID from disk. Admission is not readiness.",
  client_platform_stop: "Admit stopping only the exact owned launchd/systemd user service. No remote shutdown, arbitrary PID signals, deletion or state reset. Stack performs its normal graceful shutdown.",
  client_login_set: "Explicitly save and apply whether this local platform starts at login (default false). Does not start or restart the current platform. On macOS a live service can leave application pending until explicitly stopped. Debian requires an existing systemd user session, not root or lingering.",
  client_platform_configure: "Save explicit local platform ports and optional direct-tailnet Access/TLS configuration at the observed revision. No secrets are returned; TLS files remain on the host. Applies on the next explicit start, never restarts, runs Tailscale cert, enables Serve/Funnel or changes the tailnet. Omission disables Access or restores default ports.",
  client_local_open: "Mint a single-use local operator UI URL from this host's private platform socket once ready. Sensitive navigation authority; never log it. No anonymous loopback authority.",
  client_ui_connect: "Mint a 60-second one-use capability for the exact loopback client-UI origin configured when this host started. Works before Stack exists. Uses separate client-root local authority, never platform authority. The returned fragment URL is sensitive; native/npx parents open it without logging it. Unconfigured or remote origins are refused.",
  client_tailnet_peers: "Read bounded local Tailscale status hints without probing peers, changing Tailscale, or pairing. A node is not evidence of a Stack installation or grant. Manual exact HTTPS origins always work independently.",
  client_connection_inspect: "Inspect a manual exact HTTPS device origin, without credentials or storage. Human confirmation precedes pair_begin. Advertised origins and server ID are pinned; redirects fail closed.",
  client_pair_begin: "Persist a desktop manual-pairing secret before sending the request to the explicitly selected descriptor. Shows an approval code; trusted local Access control decides. Retry the same UUID after unknown delivery.",
  client_pair_redeem: "Redeem one saved pairing after approval. Persist the independent desktop credential before dropping intent secrets. Never poll for or infer human approval.",
  client_enrollment_begin: "Create and persist an offline desktop enrollment intent and return its request QR text/fingerprint. A permitted paired phone may inspect and explicitly approve it; scanning is not approval.",
  client_enrollment_accept: "Validate a returned phone receipt against the saved request and persist its destination. Call only after the human explicitly confirms the destination. Does not redeem or import the phone's credential.",
  client_enrollment_redeem: "Redeem a confirmed receipt directly using the desktop's retained secret and destination-bound Ed25519 proof. Stores an independent connection; exact retries recover.",
  client_connection_list: "Read secret-free metadata for every saved remote platform. Local platform and multiple remote connections coexist; connection identity never retargets silently.",
  client_connection_open: "Serialize and durably recover credential rotation, then mint a one-use scoped remote UI navigation handoff. Host keeps its refresh credential; WebView receives independent HttpOnly viewer cookies. Treat the returned URL as sensitive.",
  client_connection_forget: "Forget one exact saved connection at its observed revision. This is local removal only, not server revocation; previously opened viewer sessions remain until expiry or trusted-local Access revocation.",
  client_intent_forget: "Discard one pending local pairing or enrollment at its observed revision, including its private secret/key. The request UUID stays abandoned and cannot create a fresh intent on retry. Does not cancel a server approval or revoke any already issued credential; those remain Access-owned.",
};

export const jobSchema = z.strictObject({ id, operation: z.string(), state: z.enum(["running", "completed", "failed", "unknown"]),
  stage: z.string(), createdAt: z.number().int(), updatedAt: z.number().int(), error: z.string().nullable() });
const pairingReceipt = z.strictObject({ id, code: z.string(), expiresAt: z.number().int(), serverId: id });
const connection = z.strictObject({ id, revision: z.number().int(), label, connection: connectionSchema,
  clientId: id, credentialId: id, expiresAt: z.number().int(), pendingOpen: id.nullable() });
const pendingSchema = z.strictObject({
  pairings: z.array(z.strictObject({ id, revision: z.number().int(), label, scopes: scopeSelection, connection: connectionSchema, receipt: pairingReceipt.nullable(), connectionId: id.nullable() })),
  enrollments: z.array(z.strictObject({ id, revision: z.number().int(), label, scopes: scopeSelection, expiresAt: z.number().int(), hasReceipt: z.boolean(), connectionId: id.nullable() })),
});
const serviceSchema = z.strictObject({ owned: z.boolean(), registered: z.boolean(), running: z.boolean(), available: z.boolean(),
  ready: z.boolean(), platform: z.unknown().nullable(), path: z.string(),
  login: z.strictObject({ saved: z.boolean(), applied: z.boolean() }) });
const admission = z.strictObject({ job: jobSchema, duplicate: z.boolean() });
export const clientOutputs = {
  client_snapshot: z.strictObject({ version: z.literal(1), root: z.string(), installation: releaseSchema.nullable(), service: serviceSchema,
    configuration: z.strictObject({ revision: z.number().int(), saved: platformConfigurationSchema, pending: z.boolean() }),
    connections: z.array(connection), pending: pendingSchema, jobs: z.array(jobSchema) }),
  client_job_get: jobSchema,
  client_prerequisites: z.strictObject({ platform: z.string(), architecture: z.string(), nodeVersion: z.string(), supported: z.boolean(),
    dependencies: z.array(z.strictObject({ name: z.string(), available: z.boolean() })), serviceAvailable: z.boolean() }),
  client_qr_render: qrRenderSchema,
  client_install_plan: z.strictObject({ release: releaseSchema, directory: z.string(), platformState: z.string(), requires: z.array(z.string()),
    effects: z.array(z.string()), startsPlatform: z.literal(false), changesLogin: z.literal(false) }),
  client_install: admission, client_platform_start: admission, client_platform_stop: admission, client_login_set: admission,
  client_platform_configure: z.strictObject({ revision: z.number().int(), applied: z.literal(false) }),
  client_local_open: z.strictObject({ url: z.string(), expiresInSeconds: z.literal(60) }),
  client_ui_connect: z.strictObject({ url: z.string(), expiresInSeconds: z.literal(60) }),
  client_tailnet_peers: z.strictObject({ available: z.boolean(), truncated: z.boolean(), peers: z.array(z.strictObject({ id: z.string(), name: z.string(), addresses: z.array(z.string()), online: z.boolean() })) }),
  client_connection_inspect: connectionSchema,
  client_pair_begin: z.strictObject({ id, receipt: pairingReceipt, connectionId: id.nullable() }),
  client_pair_redeem: z.strictObject({ connectionId: id }),
  client_enrollment_begin: z.strictObject({ id, text: qrTextSchema, fingerprint: z.string(), expiresAt: z.number().int() }),
  client_enrollment_accept: z.strictObject({ id, receipt: enrollmentReceiptSchema }),
  client_enrollment_redeem: z.strictObject({ connectionId: id }),
  client_connection_list: z.strictObject({ connections: z.array(connection), pending: pendingSchema }),
  client_connection_open: z.object({ url: z.string(), expiresAt: z.number().int(), serverId: id }),
  client_connection_forget: z.strictObject({ forgotten: z.literal(true), revoked: z.literal(false) }),
  client_intent_forget: z.strictObject({ forgotten: z.literal(true), cancelledRemotely: z.literal(false) }),
} as const satisfies Record<ClientOperation, z.ZodType>;
export type ClientInput<K extends ClientOperation> = z.infer<typeof clientInputs[K]>;
export type ClientOutput<K extends ClientOperation> = z.infer<typeof clientOutputs[K]>;
