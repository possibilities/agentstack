import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import jsQR from "jsqr";
import { AccessError, AccessStore, type Scope } from "../src/store.js";
import { handler } from "../src/ingress.js";
import { api } from "../api.js";
import { snapshotSchema } from "../src/schema.js";
import { decodeQr, encodeQr, enrollmentLifetime, originSchema } from "../src/enrollment-protocol.js";
import { createEnrollmentIntent, claimInvitation, redeemEnrollment, acceptEnrollmentReceipt, inspectEnrollmentRequest,
  approveEnrollmentRequest, signEnrollmentRedemption, type EnrollmentSponsor } from "../src/enrollment-client.js";
import { renderQr } from "../src/qr.js";

const origin = "https://stack.tail.example:8943";
const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 5555 };
const secret = () => randomBytes(32).toString("base64url");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stack-enrollment-"));
  let offset = 0, online = true;
  let store = new AccessStore(root, () => Date.now() + offset);
  const env = { STACK_ACCESS_HOST: peer.localAddress, STACK_ACCESS_ORIGIN: origin };
  const send: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    request.headers.set("host", new URL(request.url).host);
    return handle(request);
  };
  const handle = (request: Request, actualPeer = peer) => handler({ store, env, origin: "documents", verify: async observed => {
    if (!online || observed.remoteAddress !== peer.remoteAddress) throw new AccessError("tailnet_unverified", 403);
  } })(request, actualPeer);
  const post = (path: string, input: unknown, token?: string, headers: Record<string, string> = {}) => handle(new Request(`${origin}/v1/access/enrollment/${path}`, {
    method: "POST", headers: { host: new URL(origin).host, "content-type": "application/json", "x-stack-server-id": store.serverId,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers }, body: JSON.stringify(input),
  }));
  return { root, env, get store() { return store; }, send, post, handle,
    set online(value: boolean) { online = value; }, advance(ms: number) { offset += ms; },
    reopen() { store.close(); store = new AccessStore(root, () => Date.now() + offset); },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}
async function invite(f: ReturnType<typeof fixture>, scopes: Scope[] = ["brain:share", "content:read", "access:enroll"]) {
  const input = { requestId: randomUUID(), secret: secret(), kind: "android", scopes, expiresAt: f.store.now() + 590_000 };
  const operation = api.operations.find(op => op.name === "enrollment_invite_create")!;
  const output = await operation.call({ store: f.store, ingress: null, env: f.env }, input) as any;
  return { input, ...output };
}
async function phone(f: ReturnType<typeof fixture>, scopes: Scope[] = ["brain:share", "content:read", "access:enroll"]) {
  const invitation = await invite(f, scopes);
  const intent = await createEnrollmentIntent({ kind: "android", label: "Phone", scopes });
  const receipt = await claimInvitation(intent, invitation.qr.text, f.send);
  const credential = await redeemEnrollment(intent, encodeQr(receipt), f.send);
  const tokens = f.store.refresh(credential.refreshToken, randomUUID(), "access");
  const sponsor: EnrollmentSponsor = { origin, serverId: f.store.serverId, accessToken: tokens.accessToken };
  return { invitation, intent, receipt, credential, tokens, sponsor };
}

// Protocol owner: real store + HTTP handlers + portable client. Protects independent
// credentials and durable retries, which existing manual pairing tests cannot cover.
test("local invitation enrolls a phone; phone inducts blank Chrome and desktop clients with recoverable independent credentials", async () => {
  const f = fixture();
  try {
    const parent = await phone(f);
    const replay = f.store.createInvitation(parent.invitation.input, origin);
    assert.deepEqual(replay, parent.invitation.invitation);
    const issued: string[] = [];
    const childTokens: string[] = [];
    for (const kind of ["chrome", "desktop"] as const) {
      const intent = await createEnrollmentIntent({ kind, label: `${kind} — 工作`, scopes: ["content:read", "brain:share"] });
      const requestText = encodeQr(intent.request);
      assert.ok(!requestText.includes(intent.redemptionSecret));
      const preview = await inspectEnrollmentRequest(parent.sponsor, requestText, f.send);
      assert.deepEqual(preview.allowedScopes.sort(), ["brain:share", "content:read"]);
      const receipt = await approveEnrollmentRequest(parent.sponsor, requestText, ["content:read"], f.send);
      // Simulate a lost approval response followed by a server restart.
      f.reopen();
      assert.deepEqual(await approveEnrollmentRequest(parent.sponsor, requestText, ["content:read"], f.send), receipt);
      const imported = await acceptEnrollmentReceipt(intent, encodeQr(receipt));
      assert.equal(imported.origin, origin);
      const credential = await redeemEnrollment(intent, encodeQr(receipt), f.send);
      f.reopen();
      assert.deepEqual(await redeemEnrollment(intent, encodeQr(receipt), f.send), credential);
      issued.push(credential.credentialId);
      assert.notEqual(credential.refreshToken, parent.tokens.refreshToken);
      const token = f.store.refresh(credential.refreshToken, randomUUID(), "content");
      childTokens.push(token.accessToken);
      assert.equal(f.store.authorize(token.accessToken, "content", "content:read").kind, kind);
      assert.throws(() => f.store.authorize(token.accessToken, "content", "brain:share"), /insufficient_scope/);
      await assert.rejects(redeemEnrollment(intent, encodeQr(receipt), f.send), /redemption_already_rotated/);
    }
    const snapshot = snapshotSchema.parse({ ...f.store.inventory(), ingress: null });
    const grants = snapshot.grants.filter(g => g.sponsor_credential_id === parent.credential.credentialId);
    assert.equal(grants.length, 2);
    assert.ok(grants.every(g => g.enrollment_id));
    f.store.revoke("credential", parent.credential.credentialId);
    for (const token of childTokens) assert.ok(f.store.authorize(token, "content", "content:read"));
    f.store.revoke("credential", issued[0]!);
    assert.throws(() => f.store.authorize(childTokens[0]!, "content", "content:read"), /credential_revoked/);
    assert.ok(f.store.authorize(childTokens[1]!, "content", "content:read"));
    // Provenance outlives ephemeral QR records.
    f.advance(enrollmentLifetime + 1);
    f.store.cloudGrant("cleanup", ["content.get"]);
    assert.equal(f.store.inventory().enrollments.length, 0);
    assert.equal(f.store.inventory().grants.filter(g => g.sponsor_credential_id === parent.credential.credentialId).length, 2);
    const forbidden = [parent.invitation.input.secret, parent.intent.redemptionSecret, parent.intent.privateKey, parent.credential.refreshToken, parent.tokens.refreshToken];
    for (const value of forbidden) {
      assert.ok(!JSON.stringify(snapshot).includes(value));
      for (const file of readdirSync(join(f.root, "access"))) assert.ok(!readFileSync(join(f.root, "access", file)).includes(Buffer.from(value)), file);
    }
  } finally { f.close(); }
});

test("invitation claims are one-use, kind/scope bounded, and revocation/cancellation cannot be bypassed by retry", async () => {
  const f = fixture();
  try {
    const invitation = await invite(f, ["brain:share"]);
    const intent = await createEnrollmentIntent({ kind: "android", label: "A", scopes: ["brain:share"] });
    const payload = { inviteId: invitation.invitation.id, secret: invitation.input.secret, request: encodeQr(intent.request) };
    await error(await f.post("claim", { ...payload, secret: secret() }), 401, "invitation_invalid");
    for (const changed of [{ kind: "chrome" as const }, { scopes: ["access:enroll" as const] }])
      await error(await f.post("claim", { ...payload, request: encodeQr({ ...intent.request, ...changed }) }), 403, "invitation_policy_mismatch");
    const receipts = await Promise.all([f.post("claim", payload), f.post("claim", payload)]);
    const first = (await receipts[0]!.json()).data;
    assert.deepEqual((await receipts[1]!.json()).data, first);
    const other = await createEnrollmentIntent({ kind: "android", label: "B", scopes: ["brain:share"] });
    await error(await f.post("claim", { ...payload, request: encodeQr(other.request) }), 409, "invitation_used");
    await error(await f.post("claim", { ...payload, request: encodeQr({ ...intent.request, label: "Changed" }) }), 409, "request_conflict");
    await error(await f.post("redeem", { id: first.receipt.id, redemptionSecret: secret(), requestHash: first.receipt.requestHash, signature: "A".repeat(86) }), 401, "enrollment_invalid");
    f.store.revokeInvitation(invitation.invitation.id);
    await error(await f.post("claim", payload), 401, "invitation_invalid");
    await assert.rejects(redeemEnrollment(intent, first.qr.text, f.send), /enrollment_invalid/);
    assert.equal(f.store.inventory().credentials.length, 0);
    const local = f.store.approveEnrollment(encodeQr(other.request), ["brain:share"], origin);
    f.store.cancelEnrollment(local.id);
    assert.throws(() => f.store.approveEnrollment(encodeQr(other.request), ["brain:share"], origin), /enrollment_cancelled/);
    await assert.rejects(redeemEnrollment(other, encodeQr(local), f.send), /enrollment_invalid/);
    f.advance(enrollmentLifetime + 1);
    assert.throws(() => f.store.createInvitation(invitation.input, origin), /invitation_expired/);
  } finally { f.close(); }
});

test("delegation requires live access audience and scope, cannot amplify or propagate authority, and fences unredeemed requests", async () => {
  const f = fixture();
  try {
    const parent = await phone(f), stranger = await phone(f), powerless = await phone(f, ["brain:share"]);
    const intent = await createEnrollmentIntent({ kind: "desktop", label: "Desktop", scopes: ["content:read", "ui:control", "access:enroll"] });
    const request = encodeQr(intent.request), token = parent.tokens.accessToken;
    await error(await f.post("approve", { request, scopes: ["content:read"] }), 401, "unauthorized");
    await error(await f.post("approve", { request, scopes: ["content:read"] }, powerless.tokens.accessToken), 403, "insufficient_scope");
    const brain = f.store.refresh(parent.tokens.refreshToken, randomUUID(), "brain");
    await error(await f.post("approve", { request, scopes: ["content:read"] }, brain.accessToken), 401, "unauthorized");
    for (const scope of ["access:enroll", "ui:control"])
      await error(await f.post("approve", { request, scopes: [scope] }, token), 403, "delegation_scope_refused");
    await error(await f.post("approve", { request, scopes: ["brain:share"] }, token), 400, "scope_not_requested");
    const data = (await (await f.post("approve", { request, scopes: ["content:read"] }, token)).json()).data;
    await error(await f.post("approve", { request, scopes: ["content:read"] }, stranger.tokens.accessToken), 409, "request_conflict");
    await error(await f.post("cancel", { id: data.receipt.id }, stranger.tokens.accessToken), 404, "not_found");
    const grant = f.store.inventory().grants.find(g => g.client_id === parent.credential.clientId)!;
    f.store.updateGrant(grant.id, grant.revision, ["access:enroll", "content:read"], []);
    await assert.rejects(redeemEnrollment(intent, data.qr.text, f.send), /enrollment_authority_changed/);
    const fresh = await createEnrollmentIntent({ kind: "chrome", label: "Fresh", scopes: ["content:read"] });
    const next = await approveEnrollmentRequest(parent.sponsor, encodeQr(fresh.request), ["content:read"], f.send);
    f.store.revoke("client", parent.credential.clientId);
    await assert.rejects(redeemEnrollment(fresh, encodeQr(next), f.send), /credential_revoked/);
    // An ordinary browser grant, even if local control gave it the scope, cannot sponsor.
    const browserSecret = secret();
    const browser = f.store.pair({ requestId: randomUUID(), redemptionSecret: browserSecret, kind: "browser", label: "Browser", scopes: ["access:enroll", "content:read"] });
    f.store.approve(browser.id, browser.code, true);
    const browserToken = f.store.refresh(f.store.redeem(browser.id, browserSecret).refreshToken, randomUUID(), "access");
    await error(await f.post("inspect", { request }, browserToken.accessToken), 403, "native_client_required");
  } finally { f.close(); }
});

test("every enrollment route fences tailnet, destination and request size before state changes", async () => {
  const f = fixture();
  try {
    for (const path of ["claim", "inspect", "approve", "cancel", "redeem"]) {
      f.online = false;
      await error(await f.post(path, {}), 403, "tailnet_unverified");
      f.online = true;
      await error(await f.post(path, {}, undefined, { "x-stack-server-id": randomUUID() }), 409, "server_identity_mismatch");
      await error(await f.post(path, {}, undefined, { host: "wrong.example:8943" }), 403, "enrollment_host_refused");
      await error(await f.post(path, {}, undefined, { origin: "https://evil.example" }), 403, "origin_refused");
      await error(await f.post(path, {}, undefined, { "tailscale-user-login": "owner@example.com" }), 403, "forwarded_headers_refused");
      await error(await f.post(path, { large: "x".repeat(8192) }), 413, "payload_too_large");
    }
    assert.equal(f.store.inventory().enrollments.length, 0);
    assert.equal(f.store.inventory().credentials.length, 0);
  } finally { f.close(); }
});

test("client rejects altered receipts and replacement servers before transmitting the device secret", async () => {
  const f = fixture();
  try {
    const intent = await createEnrollmentIntent({ kind: "chrome", label: "Extension", scopes: ["content:read"] });
    const receipt = f.store.approveEnrollment(encodeQr(intent.request), ["content:read"], origin);
    for (const changed of [{ requestHash: "0".repeat(64) }, { requestId: randomUUID() }, { scopes: ["access:enroll" as const] }])
      await assert.rejects(acceptEnrollmentReceipt(intent, encodeQr({ ...receipt, ...changed })), /enrollment_receipt_mismatch/);
    let calls = 0;
    const replaced: typeof fetch = async (_url, init) => {
      calls++;
      assert.equal(init?.body, undefined);
      return Response.json({ ok: true, data: { serverId: randomUUID() } });
    };
    await assert.rejects(redeemEnrollment(intent, encodeQr(receipt), replaced), /server_identity_mismatch/);
    assert.equal(calls, 1);
    await assert.rejects(redeemEnrollment(intent, encodeQr(receipt), async () => new Response("x".repeat(65537))), /enrollment_response_too_large/);
    for (const value of ["http://stack.example", "https://localhost", "https://127.0.0.1:8943", "https://[::1]", "https://user:pass@stack.example", `${origin}/path`, `${origin}#secret`])
      assert.equal(originSchema.safeParse(value).success, false, value);
  } finally { f.close(); }
});

test("enrollment capacity is recoverable and expiry never creates or revives a credential", async () => {
  const f = fixture();
  try {
    const parent = await phone(f);
    const intents = await Promise.all(Array.from({ length: 11 }, () => createEnrollmentIntent({ kind: "chrome", label: "Browser", scopes: ["content:read"] })));
    const receipts = [];
    for (const intent of intents.slice(0, 10)) receipts.push(await approveEnrollmentRequest(parent.sponsor, encodeQr(intent.request), ["content:read"], f.send));
    const request = encodeQr(intents[10]!.request);
    await error(await f.post("approve", { request, scopes: ["content:read"] }, parent.tokens.accessToken), 429, "enrollment_capacity");
    assert.equal((await f.post("cancel", { id: receipts[0]!.id }, parent.tokens.accessToken)).status, 200);
    assert.equal((await f.post("approve", { request, scopes: ["content:read"] }, parent.tokens.accessToken)).status, 200);
    assert.equal(f.store.inventory().credentials.length, 1);
    f.advance(enrollmentLifetime + 1);
    await error(await f.post("redeem", { id: receipts[1]!.id, requestHash: receipts[1]!.requestHash, redemptionSecret: intents[1]!.redemptionSecret, signature: "A".repeat(86) }), 401, "enrollment_invalid");
    assert.throws(() => f.store.approveEnrollment(request, ["content:read"], origin), /invalid_enrollment_request/);
    assert.equal(f.store.inventory().credentials.length, 1);
  } finally { f.close(); }
});

test("a short invitation expiry cannot recycle a still-live device request into a second enrollment", async () => {
  const f = fixture();
  try {
    const invitation = f.store.createInvitation({ requestId: randomUUID(), secret: secret(), kind: "android", scopes: ["brain:share"], expiresAt: f.store.now() + 1000 }, origin);
    const intent = await createEnrollmentIntent({ kind: "android", label: "Phone", scopes: ["brain:share"] });
    const text = encodeQr(intent.request);
    const receipt = f.store.claimInvitation(invitation.id, invitation.secret, text);
    f.store.redeemEnrollment(receipt.id, intent.redemptionSecret, receipt.requestHash, await signEnrollmentRedemption(intent, receipt));
    f.advance(2000);
    f.store.cloudGrant("collect expired records", ["content.get"]);
    assert.throws(() => f.store.approveEnrollment(text, ["brain:share"], origin), /enrollment_expired/);
    assert.equal(f.store.inventory().credentials.length, 1);
  } finally { f.close(); }
});

test("QR matrices independently decode to the exact versioned payload, with bounded strict parsing", async () => {
  const f = fixture();
  try {
    const invitation = await invite(f);
    const intent = await createEnrollmentIntent({ kind: "desktop", label: "工作 🐈".repeat(10), scopes: ["brain:share", "brain:status", "content:read", "ui:view", "ui:control"] });
    const receipt = f.store.approveEnrollment(encodeQr(intent.request), ["content:read"], origin);
    for (const text of [invitation.qr.text, encodeQr(intent.request), encodeQr(receipt)]) {
      const qr = renderQr(text), scale = 4, size = (qr.size + 2 * qr.quietZone) * scale;
      const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
      qr.rows.forEach((row, y) => [...row].forEach((module, x) => {
        if (module !== "1") return;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const index = (((y + qr.quietZone) * scale + dy) * size + (x + qr.quietZone) * scale + dx) * 4;
          rgba[index] = rgba[index + 1] = rgba[index + 2] = 0;
        }
      }));
      assert.equal(jsQR.default(rgba, size, size)?.data, text);
      assert.throws(() => decodeQr(text, Date.now() + enrollmentLifetime + 1), /expired/);
    }
    for (const text of ["https://evil.example", "x".repeat(2049), encodeQr(intent.request).replace("v1", "v2"), `${encodeQr(intent.request)}=`, encodeQr(intent.request).replace("/request#", "/receipt#")])
      assert.throws(() => decodeQr(text));
    assert.throws(() => encodeQr({ ...intent.request, scopes: ["brain:share", "brain:share"] }));
  } finally { f.close(); }
});

test("version-1 canonical wire matches the independently generated Android integration vector", async () => {
  const now = 1_799_999_900_000;
  const request = { v: 1 as const, type: "request" as const, expiresAt: 1_800_000_000_000,
    id: "11111111-1111-4111-8111-111111111111", kind: "chrome" as const, label: "Work browser",
    scopes: ["content:read" as const, "brain:share" as const], commitment: "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
    publicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
  // Generated with Python's json/base64/hashlib, not this encoder. Locks the cross-language contract.
  const text = "stack-access://v1/request#eyJ2IjoxLCJleHBpcmVzQXQiOjE4MDAwMDAwMDAwMDAsInR5cGUiOiJyZXF1ZXN0IiwiaWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJraW5kIjoiY2hyb21lIiwibGFiZWwiOiJXb3JrIGJyb3dzZXIiLCJzY29wZXMiOlsiYnJhaW46c2hhcmUiLCJjb250ZW50OnJlYWQiXSwiY29tbWl0bWVudCI6IjBmMDA3Mzg1YjZmOWQ0YjdlZWIyNzQ4NjA1YWZlMWE5ODRhMGEzYmZhM2YwMTRkMDllMmE3ODRjZTllNWNkMWEiLCJwdWJsaWNLZXkiOiIxMXFZQVlLeENyZlZTXzdUeVdRSE9nN2hjdlBhcGlNbHJ3SWFhUGNIVVJvIn0";
  assert.equal(encodeQr(request), text);
  assert.equal(decodeQr(text, now).type, "request");
  const receipt = { v: 1 as const, type: "receipt" as const, expiresAt: request.expiresAt, id: randomUUID(), serverId: randomUUID(), origin,
    requestId: request.id, requestHash: "56fa2dbb8e48dc1619ddbd89f98e49c68ec4d5d1c844dee277b0edb0187406be", scopes: ["content:read" as const] };
  assert.deepEqual(await acceptEnrollmentReceipt({ request, redemptionSecret: "A".repeat(43), privateKey: "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g" }, encodeQr(receipt), now), receipt);
});

test("a forged return destination cannot harvest redemption proof usable at the real server", async () => {
  const f = fixture();
  try {
    const intent = await createEnrollmentIntent({ kind: "chrome", label: "Extension", scopes: ["content:read"] });
    const receipt = f.store.approveEnrollment(encodeQr(intent.request), ["content:read"], origin);
    // Even knowing the secret and a proof made for a phishing server is insufficient.
    for (const change of [{ origin: "https://phishing.example" }, { serverId: randomUUID() }, { id: randomUUID() }]) {
      const signature = await signEnrollmentRedemption(intent, { ...receipt, ...change });
      await error(await f.post("redeem", { id: receipt.id, requestHash: receipt.requestHash, redemptionSecret: intent.redemptionSecret, signature }), 401, "enrollment_proof_invalid");
    }
    await error(await f.post("redeem", { id: receipt.id, requestHash: receipt.requestHash, redemptionSecret: intent.redemptionSecret, signature: "A".repeat(86) }), 401, "enrollment_proof_invalid");
    assert.equal(f.store.inventory().credentials.length, 0);
    assert.ok((await redeemEnrollment(intent, encodeQr(receipt), f.send)).credentialId);
  } finally { f.close(); }
});
