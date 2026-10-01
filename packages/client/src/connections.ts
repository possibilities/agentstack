import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createManualPairingIntent, inspectConnection, requestManualPairing, redeemManualPairing,
  refreshConnection, openRemoteUi, type ConnectionDescriptor, type ManualPairingIntent } from "@stack/access/connection-client";
import { acceptEnrollmentReceipt, createEnrollmentIntent, encodeQr, enrollmentRequestHash, redeemEnrollment, type EnrollmentIntent } from "@stack/access/enrollment-client";
import type { ClientState } from "./state.js";
import { digest } from "./state.js";

type Credential = { clientId: string; credentialId: string; refreshToken: string; expiresAt: number; serverId: string };
type Connection = { id: string; label: string; descriptor: ConnectionDescriptor; credential: Credential;
  opening?: { requestId: string; refreshId: string; refreshToken: string; accessToken?: string };
  opened?: { requestId: string; url: string; expiresAt: number; serverId: string } };
type Pairing = { digest: string; connection: ConnectionDescriptor; intent: ManualPairingIntent;
  receipt?: { id: string; code: string; expiresAt: number; serverId: string }; connectionId?: string };
type Enrollment = { digest: string; intent: EnrollmentIntent; receipt?: string; connectionId?: string };

/** Only the single client host calls this owner; secrets never enter its projections. */
export class Connections {
  constructor(readonly state: ClientState) {}
  list() {
    return this.state.records<Connection>("connection:").map(({ revision, value }) => ({ id: value.id, revision, label: value.label,
      connection: value.descriptor, clientId: value.credential.clientId, credentialId: value.credential.credentialId,
      expiresAt: value.credential.expiresAt, pendingOpen: value.opening?.requestId ?? null }));
  }
  pending() {
    return { pairings: this.state.records<Pairing>("pairing:").map(({ key, revision, value }) => ({ id: key.slice(8), revision, label: value.intent.label, scopes: value.intent.scopes,
      connection: value.connection, receipt: value.receipt ?? null, connectionId: value.connectionId ?? null })),
    enrollments: this.state.records<Enrollment>("enrollment:").map(({ key, revision, value }) => ({ id: key.slice(11), revision, label: value.intent.request.label, scopes: value.intent.request.scopes,
      expiresAt: value.intent.request.expiresAt, hasReceipt: !!value.receipt, connectionId: value.connectionId ?? null })) };
  }
  async pair(input: { requestId: string; label: string; connection: ConnectionDescriptor; scopes: ManualPairingIntent["scopes"] }) {
    const key = `pairing:${input.requestId}`;
    if (this.state.read(`abandoned:${input.requestId}`)) throw new Error("intent_abandoned");
    const completed = this.state.read<{ digest: string; receipt: NonNullable<Pairing["receipt"]>; connectionId: string }>(`paired:${input.requestId}`)?.value;
    if (completed) {
      if (completed.digest !== digest(input)) throw new Error("request_conflict");
      return { id: input.requestId, receipt: completed.receipt, connectionId: completed.connectionId };
    }
    let saved = this.state.read<Pairing>(key)?.value;
    const expected = digest(input);
    if (saved && saved.digest !== expected) throw new Error("request_conflict");
    if (!saved) {
      if (this.state.records("pairing:").length >= 100) throw new Error("pairing_capacity");
      saved = { digest: expected, connection: input.connection, intent: createManualPairingIntent(input.label, input.scopes) };
      this.state.write(key, saved); // BEFORE any remote admission
    }
    if (saved.connectionId) return { id: input.requestId, receipt: saved.receipt!, connectionId: saved.connectionId };
    const receipt = await requestManualPairing(saved.connection, saved.intent);
    saved.receipt = receipt; this.state.write(key, saved);
    return { id: input.requestId, receipt, connectionId: null };
  }
  async redeemPairing(id: string) {
    const key = `pairing:${id}`, saved = this.state.read<Pairing>(key)?.value;
    if (!saved) throw new Error("pairing_not_found");
    if (saved.connectionId) return { connectionId: saved.connectionId };
    if (!saved.receipt) throw new Error("pairing_not_admitted");
    if (this.list().length >= 100) throw new Error("connection_capacity");
    const credential = await redeemManualPairing(saved.connection, saved.receipt.id, saved.intent);
    const connectionId = randomUUID();
    this.state.transaction(() => {
      this.state.write(`connection:${connectionId}`, { id: connectionId, label: saved.intent.label, descriptor: saved.connection, credential } satisfies Connection);
      // Keep only retry metadata, not private intent material, after durable credential installation.
      this.state.remove(key);
      this.state.write(`paired:${id}`, { connectionId, digest: saved.digest, receipt: saved.receipt });
    });
    return { connectionId };
  }
  async enroll(input: { requestId: string; label: string; scopes: ManualPairingIntent["scopes"] }) {
    const key = `enrollment:${input.requestId}`;
    if (this.state.read(`abandoned:${input.requestId}`)) throw new Error("intent_abandoned");
    if (this.state.read(`paired:${input.requestId}`)) throw new Error("enrollment_already_completed");
    let saved = this.state.read<Enrollment>(key)?.value;
    if (saved && saved.digest !== digest(input)) throw new Error("request_conflict");
    if (!saved) {
      if (this.state.records("enrollment:").length >= 100) throw new Error("enrollment_capacity");
      saved = { digest: digest(input), intent: await createEnrollmentIntent({ kind: "desktop", label: input.label, scopes: input.scopes }) };
      this.state.write(key, saved);
    }
    const text = encodeQr(saved.intent.request);
    return { id: input.requestId, text, fingerprint: await enrollmentRequestHash(text), expiresAt: saved.intent.request.expiresAt };
  }
  async accept(id: string, text: string) {
    const key = `enrollment:${id}`, saved = this.state.read<Enrollment>(key)?.value;
    if (!saved) throw new Error("enrollment_not_found");
    const receipt = await acceptEnrollmentReceipt(saved.intent, text);
    if (saved.receipt && saved.receipt !== text) throw new Error("request_conflict");
    saved.receipt = text; this.state.write(key, saved);
    return { id, receipt };
  }
  async redeemEnrollment(id: string) {
    const key = `enrollment:${id}`, saved = this.state.read<Enrollment>(key)?.value;
    if (!saved?.receipt) throw new Error("enrollment_receipt_required");
    if (this.list().length >= 100) throw new Error("connection_capacity");
    const receipt = await acceptEnrollmentReceipt(saved.intent, saved.receipt);
    const descriptor = await inspectConnection(receipt.origin);
    if (descriptor.serverId !== receipt.serverId) throw new Error("server_identity_mismatch");
    const credential = await redeemEnrollment(saved.intent, saved.receipt);
    const connectionId = randomUUID();
    this.state.transaction(() => {
      this.state.write(`connection:${connectionId}`, { id: connectionId, label: saved.intent.request.label, descriptor, credential } satisfies Connection);
      this.state.remove(key); this.state.write(`paired:${id}`, { connectionId });
    });
    return { connectionId };
  }
  async open(id: string, requestId: string) {
    const key = `connection:${id}`, connection = this.state.read<Connection>(key)?.value;
    if (!connection) throw new Error("connection_not_found");
    if (!connection.descriptor.uiOrigin) throw new Error("ui_not_configured");
    if (connection.opened?.requestId === requestId) {
      if (connection.opened.expiresAt <= Date.now()) throw new Error("ui_handoff_expired");
      return connection.opened;
    }
    if (connection.opening && connection.opening.requestId !== requestId) throw new Error("refresh_recovery_required");
    if (!connection.opening) {
      connection.opening = { requestId, refreshId: randomUUID(), refreshToken: connection.credential.refreshToken };
      this.state.write(key, connection);
    }
    const opening = connection.opening;
    if (!opening.accessToken) {
      const refreshed = await refreshConnection(connection.descriptor, { refreshToken: opening.refreshToken, requestId: opening.refreshId, audience: "ui" });
      connection.credential.refreshToken = refreshed.refreshToken;
      opening.accessToken = refreshed.accessToken;
      this.state.write(key, connection); // Atomic rotation receipt + new credential
    }
    const result = await openRemoteUi(connection.descriptor, opening.accessToken, requestId);
    connection.opened = { requestId, ...result }; delete connection.opening;
    this.state.write(key, connection);
    return result;
  }
  forget(id: string, revision: number) { this.state.remove(`connection:${id}`, revision); return { forgotten: true as const, revoked: false as const }; }
  forgetIntent(kind: "pairing" | "enrollment", id: string, revision: number) {
    this.state.transaction(() => { this.state.remove(`${kind}:${id}`, revision); this.state.write(`abandoned:${id}`, { kind }); });
    return { forgotten: true as const, cancelledRemotely: false as const };
  }
}

export function tailnetPeers(): Promise<{ available: boolean; peers: Array<{ id: string; name: string; addresses: string[]; online: boolean }>; truncated: boolean }> {
  return new Promise(resolve => execFile("tailscale", ["status", "--json"], { timeout: 10_000, maxBuffer: 1_048_576 }, (error, stdout) => {
    if (error) { resolve({ available: false, peers: [], truncated: false }); return; }
    try {
      const status = JSON.parse(stdout);
      if (status.BackendState !== "Running") { resolve({ available: false, peers: [], truncated: false }); return; }
      const rows = Object.values(status.Peer ?? {}) as Array<Record<string, unknown>>;
      resolve({ available: true, truncated: rows.length > 200, peers: rows.slice(0, 200).map(row => ({
        id: typeof row.ID === "string" ? row.ID.slice(0, 100) : "", name: typeof row.DNSName === "string" ? row.DNSName.slice(0, 253) : "",
        addresses: Array.isArray(row.TailscaleIPs) ? row.TailscaleIPs.filter((ip): ip is string => typeof ip === "string").slice(0, 8) : [], online: row.Online === true,
      })) });
    } catch { resolve({ available: false, peers: [], truncated: false }); }
  }));
}
