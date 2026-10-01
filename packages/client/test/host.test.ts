import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as tar from "tar";
import { socketCall, withLocalAuth } from "@stack/api";
import { startClientHost } from "../src/host.js";
import { bundleSchema, type Release } from "../src/contract.js";
import { api as accessApi } from "@stack/access";
import { encodeQr } from "@stack/access/enrollment-protocol";

async function bundle(root: string, unsafe = false) {
  const source = join(root, `source-${randomUUID()}`); await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "runtime"));
  const manifest = bundleSchema.parse({ version: "test-1", platform: process.platform, architecture: process.arch,
    codexnk: { tag: "codexnk-v0.1.7", sha: "3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c" } });
  await writeFile(join(source, "stack-release.json"), JSON.stringify(manifest));
  await writeFile(join(source, "bin", "stack"), "#!/bin/sh\nexit 0\n");
  // Release producer fixture, not a mocked host: exercises the real installer
  // subprocess without network, native models, credentials or a human home.
  await writeFile(join(source, "runtime", "codexnk-install.py"), "import pathlib,os\np=pathlib.Path.home()/'.local/libexec/codexnk/codex'\np.parent.mkdir(parents=True,exist_ok=True)\np.write_text('#!/bin/sh\\nexit 0\\n')\np.chmod(0o700)\n");
  if (unsafe) await symlink("/etc/passwd", join(source, "unsafe"));
  const file = join(root, `${randomUUID()}.tgz`);
  await tar.c({ gzip: true, cwd: source, file }, ["bin", "runtime", "stack-release.json", ...(unsafe ? ["unsafe"] : [])]);
  const bytes = await readFile(file);
  const release: Release = { version: manifest.version, platform: manifest.platform, architecture: manifest.architecture,
    url: "https://release.example/stack.tgz", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, unpackedBytes: 1_000_000 };
  return { bytes, release };
}
async function finished(host: Awaited<ReturnType<typeof startClientHost>>, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = await host.call("client_job_get", { id });
    if (job.state !== "running") return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("job did not finish");
}

// Strongest owning boundary: real private socket, durable jobs, archive extraction,
// and installer subprocess. Protects cold bootstrap without a running platform.
test("cold client host installs without starting Stack, recovers retries, and refuses unsafe or changed releases", async t => {
  const root = await mkdtemp(join(tmpdir(), "stack-client-install-"));
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  const originalHome = process.env.HOME; process.env.HOME = home;
  let host: Awaited<ReturnType<typeof startClientHost>> | undefined;
  try {
    const good = await bundle(root), bad = await bundle(root, true);
    let payload = good.bytes, downloads = 0;
    t.mock.method(globalThis, "fetch", async () => { downloads++; return new Response(payload); });
    host = await startClientHost({ root: join(root, "client") });
    const initial = await host.call("client_snapshot", {});
    assert.equal(initial.installation, null); assert.equal(initial.service.login.saved, false); assert.equal(initial.service.ready, false);
    await assert.rejects(startClientHost({ root: join(root, "client") }), /client_host_busy/);
    assert.equal((await host.call("client_install_plan", { release: good.release })).startsPlatform, false);
    const id = randomUUID();
    const admission = await socketCall(host.path, "tools/call", { name: "client_install", arguments: { requestId: id, release: good.release } }) as { job: { id: string } };
    assert.equal(admission.job.id, id);
    assert.equal((await finished(host, id)).state, "completed");
    assert.equal((await host.call("client_install", { requestId: id, release: good.release })).duplicate, true);
    assert.equal(downloads, 1);
    await assert.rejects(host.call("client_install", { requestId: id, release: { ...good.release, version: "other" } }), /request_conflict/);
    const installed = await host.call("client_snapshot", {});
    assert.equal(installed.installation?.sha256, good.release.sha256);
    assert.equal(installed.service.owned, false); assert.equal(installed.service.ready, false);
    const mismatch = randomUUID();
    await host.call("client_install", { requestId: mismatch, release: { ...good.release, sha256: "a".repeat(64) } });
    assert.equal((await finished(host, mismatch)).error, "release_integrity_mismatch");
    payload = bad.bytes;
    const unsafe = randomUUID(); await host.call("client_install", { requestId: unsafe, release: bad.release });
    assert.equal((await finished(host, unsafe)).error, "release_archive_refused");
    assert.equal((await host.call("client_snapshot", {})).installation?.sha256, good.release.sha256);
    assert.ok((await readdir(join(root, "client", "releases"))).every(path => !path.startsWith(".install-")));
    await host.close(); host = await startClientHost({ root: join(root, "client") });
    assert.equal((await host.call("client_job_get", { id })).state, "completed");
    assert.equal((await host.call("client_snapshot", {})).installation?.sha256, good.release.sha256);
  } finally { await host?.close(); if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; await rm(root, { recursive: true, force: true }); }
});

test("configuration preserves unset defaults and revisions; private control rejects unsafe state and malformed mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-client-control-"));
  let host: Awaited<ReturnType<typeof startClientHost>> | undefined;
  try {
    host = await startClientHost({ root });
    const config = await host.call("client_platform_configure", { expectedRevision: 0, configuration: { ports: { ui: 19001 } } });
    assert.deepEqual(config, { revision: 1, applied: false });
    assert.deepEqual((await host.call("client_snapshot", {})).configuration, { revision: 1, saved: { ports: { ui: 19001 } }, pending: true });
    await assert.rejects(host.call("client_platform_configure", { expectedRevision: 0, configuration: {} }), /revision_conflict/);
    await host.call("client_platform_configure", { expectedRevision: 1, configuration: {} });
    assert.deepEqual((await host.call("client_snapshot", {})).configuration.saved, {});
    await assert.rejects(socketCall(host.path, "tools/call", { name: "client_login_set", arguments: { requestId: randomUUID(), enabled: true, runNow: true } }), /Unrecognized key/);
    await host.close(); host = undefined;
    await chmod(root, 0o755);
    await assert.rejects(startClientHost({ root }), /client_state_permissions/);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

// Host lifecycle owns the choice of authority root and when rotation is allowed;
// LocalAuth's own tests cannot detect a platform-root mixup or leaked host socket.
test("client UI bootstrap is root/origin isolated and failed startup leaves no live socket or lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-client-authority-"));
  const origin = "http://127.0.0.1:19000", clientRoot = join(root, "client"), platformRoot = join(root, "platform");
  let host: Awaited<ReturnType<typeof startClientHost>> | undefined;
  try {
    await assert.rejects(startClientHost({ root: clientRoot, uiOrigin: "https://remote.example" }), /authentication required/);
    host = await startClientHost({ root: clientRoot, uiOrigin: origin });
    const bootstrap = await socketCall(host.path, "tools/call", { name: "client_ui_connect", arguments: {} }) as { url: string };
    const token = new URL(bootstrap.url).hash.slice(1);
    assert.equal(new URL(bootstrap.url).origin, origin);
    withLocalAuth({ STACK_STATE_DIR: platformRoot }, auth => assert.throws(() => auth.redeem(token, origin, "ui")));
    withLocalAuth({ STACK_STATE_DIR: clientRoot }, auth => assert.throws(() => auth.redeem(token, "http://localhost:19000", "ui")));
    await assert.rejects(startClientHost({ root: clientRoot, uiOrigin: origin }), /client_host_busy/);
    const session = withLocalAuth({ STACK_STATE_DIR: clientRoot }, auth => auth.redeem(token, origin, "ui"));
    withLocalAuth({ STACK_STATE_DIR: clientRoot }, auth => assert.throws(() => auth.redeem(token, origin, "ui")));
    await host.close(); host = undefined;
    await chmod(join(clientRoot, "local-auth"), 0o755);
    await assert.rejects(startClientHost({ root: clientRoot, uiOrigin: origin }), /authentication required/);
    assert.ok(!(await readdir(clientRoot)).some(path => path === "client.sock" || path === "client.sock.starting"));
    await chmod(join(clientRoot, "local-auth"), 0o700);
    host = await startClientHost({ root: clientRoot, uiOrigin: origin });
    withLocalAuth({ STACK_STATE_DIR: clientRoot }, auth => assert.throws(() => auth.session(session.token, origin, "ui")));
    assert.equal((await host.call("client_snapshot", {})).installation, null);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

// Distinct from the portable-client tests: real host persistence survives an
// ambiguous network acknowledgement and retains several independent destinations.
test("host retains manual and phone-mediated enrollment across lost responses without exposing private credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "stack-client-pair-"));
  const context = await accessApi.createContext({ STACK_STATE_DIR: join(root, "platform") });
  const { handler } = await import(new URL("./src/ingress.js", import.meta.resolve("@stack/access")).href);
  const origin = "https://server.tail.example:8943";
  const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1234 };
  const route = handler({ store: context.store, origin: "documents", env: { STACK_ACCESS_HOST: peer.localAddress,
    STACK_ACCESS_ORIGIN: origin, STACK_ACCESS_UI_ORIGIN: "https://server.tail.example:8945" }, verify: async () => {} });
  let lose = "/v1/access/pair", host: Awaited<ReturnType<typeof startClientHost>> | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const request = new Request(url, init); request.headers.set("host", new URL(url).host);
    const response = await route(request, peer);
    if (new URL(url).pathname === lose) { lose = ""; throw new Error("lost response"); }
    return response;
  });
  try {
    host = await startClientHost({ root: join(root, "client") });
    const connection = await host.call("client_connection_inspect", { origin });
    const input = { requestId: randomUUID(), label: "Laptop", connection, scopes: ["ui:view" as const] };
    await assert.rejects(host.call("client_pair_begin", input), /lost response/);
    await host.close(); host = await startClientHost({ root: join(root, "client") });
    const saved = (await host.call("client_snapshot", {})).pending.pairings[0]!;
    assert.equal(saved.id, input.requestId);
    assert.ok(!JSON.stringify(saved).includes("redemptionSecret"));
    const retry = await host.call("client_pair_begin", input);
    assert.equal(context.store.inventory().pairings.length, 1);
    context.store.approve(retry.receipt.id, retry.receipt.code, true);
    lose = "/v1/access/redeem";
    await assert.rejects(host.call("client_pair_redeem", { id: input.requestId }), /lost response/);
    await host.close(); host = await startClientHost({ root: join(root, "client") });
    const manual = await host.call("client_pair_redeem", { id: input.requestId });
    assert.deepEqual(await host.call("client_pair_redeem", { id: input.requestId }), manual);
    assert.equal((await host.call("client_pair_begin", input)).connectionId, manual.connectionId);
    const phoneSecret = "A".repeat(43);
    const phone = context.store.pair({ requestId: randomUUID(), label: "Phone", kind: "android", scopes: ["access:enroll", "ui:view"], redemptionSecret: phoneSecret });
    context.store.approve(phone.id, phone.code, true);
    const sponsor = context.store.refresh(context.store.redeem(phone.id, phoneSecret).refreshToken, randomUUID(), "access");
    const enroll = await host.call("client_enrollment_begin", { requestId: randomUUID(), label: "Other laptop", scopes: ["ui:view"] });
    const receipt = context.store.approveEnrollment(enroll.text, ["ui:view"], origin, sponsor.accessToken);
    await host.call("client_enrollment_accept", { id: enroll.id, receipt: encodeQr(receipt) });
    const enrolled = await host.call("client_enrollment_redeem", { id: enroll.id });
    assert.notEqual(enrolled.connectionId, manual.connectionId);
    const list = await host.call("client_connection_list", {});
    assert.equal(list.connections.length, 2);
    assert.equal(list.pending.enrollments.length, 0); assert.equal(list.pending.pairings.length, 0);
    assert.ok(!/refreshToken|privateKey|redemptionSecret|accessToken/.test(JSON.stringify(list)));
    const link = await host.call("client_connection_open", { id: enrolled.connectionId, requestId: randomUUID() });
    assert.equal(new URL(link.url).origin, connection.uiOrigin);
    const selected = list.connections.find(row => row.id === manual.connectionId)!;
    await assert.rejects(host.call("client_connection_forget", { id: selected.id, expectedRevision: selected.revision + 1 }), /revision_conflict/);
    await host.call("client_connection_forget", { id: selected.id, expectedRevision: selected.revision });
    assert.equal((await host.call("client_connection_list", {})).connections[0]!.id, enrolled.connectionId);
    assert.ok(context.store.inventory().credentials.every(row => row.revoked === null), "forgetting is not remote revocation");
    const abandoned = await host.call("client_enrollment_begin", { requestId: randomUUID(), label: "Discard", scopes: ["ui:view"] });
    const pending = (await host.call("client_connection_list", {})).pending.enrollments[0]!;
    await host.call("client_intent_forget", { kind: "enrollment", id: abandoned.id, expectedRevision: pending.revision });
    await assert.rejects(host.call("client_enrollment_begin", { requestId: abandoned.id, label: "Discard", scopes: ["ui:view"] }), /intent_abandoned/);
  } finally { await host?.close(); await accessApi.closeContext(context); await rm(root, { recursive: true, force: true }); }
});
