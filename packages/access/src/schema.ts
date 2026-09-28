import { z } from "zod";
import { scopes } from "./store.js";

const id = z.uuid(), timestamp = z.number().int();
export const clientSchema = z.object({ id, label: z.string(), kind: z.string(), created: timestamp, revoked: timestamp.nullable() });
export const pairingSchema = z.object({ id, code: z.string(), label: z.string(), kind: z.string(), scopes: z.array(z.enum(scopes)), created: timestamp, expires: timestamp, state: z.enum(["pending", "approved", "denied", "redeemed", "expired"]) });
export const grantSchema = z.object({ id, client_id: id, network: z.enum(["tailnet", "public-cloud"]), scopes: z.array(z.enum(scopes)), operations: z.array(z.string()), revision: z.number().int().positive(), created: timestamp, revoked: timestamp.nullable() });
export const credentialSchema = z.object({ id, client_id: id, grant_id: id, generation: z.number().int(), created: timestamp, expires: timestamp, revoked: timestamp.nullable() });
export const snapshotSchema = z.object({ serverId: id, clients: z.array(clientSchema), pairings: z.array(pairingSchema), grants: z.array(grantSchema), credentials: z.array(credentialSchema), uixSessions: z.array(z.object({ credential_id: id, expires: timestamp })), audit: z.array(z.object({ seq: z.number().int(), time: timestamp, action: z.string(), subject: z.string() })), ingress: z.object({ host: z.string(), port: z.number(), artifactPort: z.number(), uixPort: z.number().nullable() }).nullable() });
export const envelope = (data: z.ZodType) => z.object({ schema_version: z.literal(1), ok: z.literal(true), data });
export const errorEnvelope = z.object({ schema_version: z.literal(1), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });
export const pairResponse = envelope(z.object({ id, code: z.string(), expiresAt: timestamp, redemptionSecret: z.string(), serverId: id }));
export const redeemResponse = envelope(z.object({ clientId: id, credentialId: id, refreshToken: z.string(), expiresAt: timestamp, serverId: id }));
export const refreshResponse = envelope(z.object({ accessToken: z.string(), refreshToken: z.string(), audience: z.enum(["brain", "content"]), expiresAt: timestamp, credentialId: id, serverId: id }));
export const shareRequest = z.looseObject({ version: z.literal(1).optional(), client: z.string().optional(), url: z.string().optional(), text: z.string().optional(), title: z.string().optional(), tags: z.array(z.string()).optional(), collections: z.array(z.string()).optional(), idempotency_key: z.string().nullable().optional() });
export const shareResponse = envelope(z.object({ version: z.literal(1), client: z.string(), status: z.enum(["queued", "duplicate"]), job_id: z.number().int(), idempotency_key: z.string(), intent_hash: z.string(), state: z.string(), resolved_kind: z.enum(["url", "text"]), resolved_url: z.string().nullable(), extracted_from_text: z.boolean(), collections: z.array(z.string()), tags: z.array(z.string()) }));
export const statesResponse = envelope(z.object({ version: z.literal(1), shares: z.array(z.object({ job_id: z.number().int(), state: z.string(), failure_class: z.string().nullable(), document_id: z.number().int().nullable() })) }));
