import { createHmac, timingSafeEqual } from "node:crypto";
import { assertInstallationOpen, serveHttp } from "@stack/api";
import { z } from "zod";
import { decodePayload } from "./payload.js";
import { object, type DeliveryHeaders } from "./summary.js";
import type { Endpoint } from "./schema.js";
import type { GithubStore } from "./store.js";

export const maxBodyBytes = 25 * 1024 * 1024;
const memoryBudget = 64 * 1024 * 1024;
export function githubPort(env: NodeJS.ProcessEnv): number {
  const raw = env.STACK_GITHUB_PORT;
  const port = raw === undefined ? 8787 : Number(raw);
  if (raw === "" || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("STACK_GITHUB_PORT must be an integer from 0 to 65535");
  if (env.STACK_GITHUB_HOST !== undefined && env.STACK_GITHUB_HOST !== "127.0.0.1") throw new Error("GitHub intake must bind 127.0.0.1; publish only its webhook path through an explicit HTTPS reverse proxy");
  return port;
}
function signatureMatches(raw: Buffer, signature: string | null, secrets: string[]): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const supplied = Buffer.from(signature.slice(7), "hex");
  let valid = false;
  for (const secret of secrets) valid = timingSafeEqual(createHmac("sha256", secret).update(raw).digest(), supplied) || valid;
  return valid;
}
function targetMatches(endpoint: Endpoint, payload: Record<string, unknown>): boolean {
  const target = endpoint.target;
  const same = (value: unknown, expected: string) => typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
  const bound = (value: Record<string, unknown>) => endpoint.boundTargetId !== null && value.id !== undefined ? value.id === endpoint.boundTargetId : null;
  if (target.kind === "repository") {
    const repository = object(payload.repository), repo = repository.full_name;
    const oldName = object(object(object(payload.changes).repository).name).from;
    const oldOwner = object(object(object(payload.changes).owner).from);
    const previousOwner = object(oldOwner.organization).login ?? object(oldOwner.user).login ?? object(repository.owner).login;
    const previousName = typeof oldName === "string" ? oldName : repository.name;
    return bound(repository) ?? (repo === undefined || same(repo, target.repository) || typeof previousOwner === "string" && typeof previousName === "string" && same(`${previousOwner}/${previousName}`, target.repository));
  }
  if (target.kind === "organization") {
    const organization = object(payload.organization), org = organization.login;
    return bound(organization) ?? (org === undefined || same(org, target.organization) || same(object(object(payload.changes).login).from, target.organization));
  }
  if (target.kind === "enterprise") {
    const enterprise = object(payload.enterprise);
    return bound(enterprise) ?? (enterprise.slug === undefined || same(enterprise.slug, target.enterprise));
  }
  if (target.kind === "marketplace") return true;
  if (target.kind === "sponsors_listing") {
    const account = object(object(payload.sponsorship).sponsorable);
    return bound(account) ?? (account.login === undefined || same(account.login, target.account));
  }
  const appId = object(payload.installation).app_id ?? object(payload.hook).app_id;
  return !target.appId || appId === undefined || appId === target.appId;
}
class IntakeError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function startGithubIngress(store: GithubStore, env: NodeJS.ProcessEnv, changed: (endpointId: string, watches: string[], duplicate: boolean) => void) {
  let inFlight = 0, bodyBytes = 0, closing = false;
  let drained: (() => void) | undefined;
  const running = await serveHttp({ env, host: "127.0.0.1", port: githubPort(env), headersTimeout: 10_000, requestTimeout: 15_000, forceCloseConnections: true,
    async handle(request) {
      if (closing) return json(503, { error: "github_stopping" });
      const url = new URL(request.url), match = /^\/github\/webhooks\/([^/]+)$/.exec(url.pathname);
      if (!match || url.search || !z.uuid().safeParse(match[1]).success) return json(404, { error: "github_route_not_found" });
      if (request.method !== "POST") return json(405, { error: "github_method_refused" });
      let endpoint: Endpoint;
      try { endpoint = store.getEndpoint(match[1]); } catch { return json(404, { error: "github_endpoint_not_found" }); }
      if (!endpoint.enabled) return json(410, { error: "github_endpoint_disabled" });
      if (inFlight >= 8) return json(503, { error: "github_intake_busy" });
      inFlight++;
      let reserved = 0;
      try {
        const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (type !== "application/json" && type !== "application/x-www-form-urlencoded") throw new IntakeError(415, "github_content_type_refused");
        if (request.headers.has("content-encoding")) throw new IntakeError(415, "github_content_encoding_refused");
        const length = request.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) throw new IntakeError(413, "github_body_too_large");
        const event = request.headers.get("x-github-event"), deliveryId = request.headers.get("x-github-delivery");
        if (!event || !/^[a-z][a-z0-9_]{0,127}$/.test(event) || !deliveryId || !/^[a-zA-Z0-9-]{1,128}$/.test(deliveryId)) throw new IntakeError(400, "github_delivery_headers_invalid");
        const hookId = request.headers.get("x-github-hook-id"), targetId = request.headers.get("x-github-hook-installation-target-id"), targetType = request.headers.get("x-github-hook-installation-target-type");
        if ([hookId, targetId].some(value => value !== null && !/^\d{1,32}$/.test(value)) || targetType !== null && !/^[a-z_]{1,64}$/.test(targetType)) throw new IntakeError(400, "github_delivery_headers_invalid");
        const reader = request.body?.getReader();
        if (!reader) throw new IntakeError(400, "github_payload_invalid");
        const parts: Uint8Array[] = [];
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            if (reserved + value.byteLength > maxBodyBytes) throw new IntakeError(413, "github_body_too_large");
            if (bodyBytes + value.byteLength > memoryBudget) throw new IntakeError(503, "github_intake_busy");
            reserved += value.byteLength; bodyBytes += value.byteLength; parts.push(value);
          }
        } finally { reader.releaseLock(); }
        const raw = Buffer.concat(parts);
        try { assertInstallationOpen(env); } catch { throw new IntakeError(503, "github_installation_fenced"); }
        if (!signatureMatches(raw, request.headers.get("x-hub-signature-256"), store.secrets(endpoint.id))) throw new IntakeError(401, "github_signature_invalid");
        let payload: Record<string, unknown>;
        try { payload = decodePayload(raw, type); } catch { throw new IntakeError(400, "github_payload_invalid"); }
        if (!targetMatches(store.getEndpoint(endpoint.id), payload)) throw new IntakeError(422, "github_target_mismatch");
        const headers: DeliveryHeaders = { event, deliveryId, contentType: type, hookId, targetId, targetType };
        let admitted: ReturnType<GithubStore["admit"]>;
        try { admitted = store.admit(endpoint.id, headers, raw, payload); }
        catch (error) {
          const code = error instanceof Error ? error.message : "";
          throw new IntakeError(code === "github_delivery_conflict" ? 409 : code === "github_storage_full" ? 507 : code === "github_endpoint_disabled" ? 410 : 500, code === "github_delivery_conflict" || code === "github_storage_full" || code === "github_endpoint_disabled" ? code : "github_storage_unavailable");
        }
        changed(endpoint.id, admitted.watches, admitted.duplicate);
        return json(202, { accepted: true, duplicate: admitted.duplicate, sequence: admitted.record.sequence, deliveryId });
      } catch (error) {
        const failure = error instanceof IntakeError ? error : new IntakeError(400, "github_request_incomplete");
        if (failure.code !== "github_installation_fenced") { store.failure(endpoint.id, failure.code); changed(endpoint.id, [], true); }
        return json(failure.status, { error: failure.code });
      } finally { bodyBytes -= reserved; inFlight--; if (!inFlight) drained?.(); }
    },
  });
  running.server.maxHeadersCount = 64;
  running.server.maxConnections = 16;
  let close: Promise<void> | undefined;
  return { port: running.port, stopAdmission() { closing = true; }, close() {
    closing = true;
    return close ??= (async () => {
      await running.close();
      if (inFlight) await new Promise<void>(resolve => { drained = resolve; });
    })();
  } };
}
