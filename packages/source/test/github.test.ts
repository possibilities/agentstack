import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { installationControlRoot, McpEventSubscriptions, serveApi, socketCall, type EventValue, type InvocationContext, type StatePage, type StatePlan, type StateReceipt } from "@stack/api";
import type { Delivery, Endpoint, Watch, RemoteReceipt } from "../src/schema.js";

const caller: InvocationContext = { transport: "mcp", botId: "bot-1", instance: "launch-1", threadId: "main", sessionId: null };
async function fixture(extra: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "stack-github-"));
  const env = { ...process.env, ...extra, STACK_STATE_DIR: root, STACK_GITHUB_PORT: "0" };
  let served = await serveApi({ name: "source", transport: "socket", env });
  const call = <T = any>(name: string, args: Record<string, unknown> = {}, invocation?: InvocationContext) => socketCall(served.socketPath!, "tools/call", { name, arguments: args, ...(invocation ? { invocation } : {}) }) as Promise<T>;
  const create = async (target: Endpoint["target"] = { kind: "repository", repository: "owner/project" }) => {
    const endpoint = await call<Endpoint>("github_endpoint_create", { id: randomUUID(), label: "Receiver", target, publicOrigin: "https://hooks.example.com" });
    const { secret } = await call<{ secret: string }>("github_endpoint_secret_reveal", { id: endpoint.id, reveal: true });
    return { endpoint, secret };
  };
  const send = async (endpoint: Endpoint, secret: string, event: string, payload: unknown, options: { deliveryId?: string; form?: boolean; signature?: string; raw?: string; headers?: Record<string, string> } = {}) => {
    const { ingress } = await call<{ ingress: { port: number } }>("github_status");
    const raw = options.raw ?? (options.form ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload));
    return fetch(`http://127.0.0.1:${ingress.port}${endpoint.path}`, { method: "POST", headers: {
      "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json", "x-github-event": event,
      "x-github-delivery": options.deliveryId ?? randomUUID(), "x-github-hook-id": "17",
      "x-hub-signature-256": options.signature ?? `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`, ...options.headers,
    }, body: raw });
  };
  return { root, env, call, create, send, async restart() { await served.close(); served = await serveApi({ name: "source", transport: "socket", env }); },
    async close() { await served.close(); await rm(root, { recursive: true, force: true }); } };
}
const issue = (action = "opened", extra: Record<string, unknown> = {}) => ({ action, repository: { id: 3, full_name: "owner/project", owner: { login: "owner" } }, sender: { login: "human" }, issue: { id: 7, number: 4, title: "Unicode 🐙", labels: ["bug"], html_url: "https://github.com/owner/project/issues/4" }, ...extra });
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 5000; while (!await check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(await check(), "expected boundary observation did not arrive"); }

test("signed arrivals drive scoped Stack subscriptions and survive coalescing, acknowledgement, cleanup and restart", { timeout: 30_000 }, async () => {
  const f = await fixture();
  let subscriptions: McpEventSubscriptions | undefined;
  try {
    const { endpoint, secret } = await f.create();
    const inventory = await f.call<StatePage>("source_state_read", { measure: true });
    const storage = inventory.entries.find(entry => entry.id === "source:webhooks")!;
    assert.equal(storage.ownerPackage, "source");
    assert.equal(storage.coverage, "complete"); assert.ok(storage.bytes! > 0);
    assert.ok([...storage.reads, ...storage.actions].every(link => link.package === "source"));
    const watchId = randomUUID();
    const definition = { id: watchId, label: "Opened bugs", filter: { events: ["issues"], actions: ["opened"], repositories: ["OWNER/PROJECT"], predicates: [{ path: "/issue/labels", op: "contains", value: "bug" }] } };
    const watch = await f.call<Watch>("github_watch_create", definition, caller);
    assert.equal((await f.call<Watch>("github_watch_create", definition, caller)).id, watch.id);
    const snapshots: EventValue[] = [];
    subscriptions = new McpEventSubscriptions(f.env, async target => assert.equal(target.threadId, "main"), async event => { snapshots.push(event); });
    const initial = await subscriptions.subscribe("source", { topic: "github_watches_changed", scope: watch.scope, readOperation: "github_watch_read", readArguments: { id: watch.id, limit: 1 } }, caller);
    assert.equal((initial.value as { pending: number }).pending, 0);
    assert.equal((await f.send(endpoint, secret, "issues", issue("closed"))).status, 202);
    const firstPayload = issue();
    const guid = randomUUID();
    const response = await f.send(endpoint, secret, "issues", firstPayload, { deliveryId: guid });
    assert.equal(response.status, 202);
    const admitted = await response.json() as { sequence: number };
    assert.equal((await f.send(endpoint, secret, "issues", firstPayload, { deliveryId: guid })).status, 202);
    const secondGuid = randomUUID();
    const secondPayload = issue("opened", { installation: { id: 12 } });
    const second = await f.send(endpoint, secret, "issues", secondPayload, { deliveryId: secondGuid });
    assert.equal(second.status, 202);
    const secondSequence = (await second.json() as { sequence: number }).sequence;
    await until(() => snapshots.some(event => (event.value as { pending: number }).pending === 2));
    const inbox = await f.call("github_watch_read", { id: watch.id, limit: 1 });
    assert.equal(inbox.entries[0].sequence, admitted.sequence); assert.equal(inbox.nextCursor, admitted.sequence); assert.equal(inbox.pending, 2);
    const page2 = await f.call("github_watch_read", { id: watch.id, after: inbox.nextCursor, limit: 1 });
    assert.equal(page2.entries[0].sequence, secondSequence);
    assert.equal((await f.call<Watch>("github_watch_get", { id: watch.id })).acknowledgedThrough, 0, "native snapshot admission is not consumption");
    const raw = await f.call("github_delivery_payload", { sequence: admitted.sequence });
    assert.deepEqual(JSON.parse(raw.text), firstPayload);
    const acknowledged = await f.call<Watch>("github_watch_acknowledge", { id: watch.id, through: admitted.sequence, expectedAcknowledgedThrough: 0 });
    assert.equal(acknowledged.acknowledgedThrough, admitted.sequence);
    await assert.rejects(f.call("github_watch_acknowledge", { id: watch.id, through: secondSequence, expectedAcknowledgedThrough: 0 }), /cursor_changed/);
    const plan = await f.call<StatePlan>("github_history_plan", { sequences: [secondSequence] });
    assert.equal(plan.ownerPackage, "source");
    const clear = { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() };
    const cleared = await f.call<StateReceipt>("github_history_clear", clear);
    assert.equal(cleared.ownerPackage, "source");
    assert.deepEqual(await f.call("github_history_clear", clear), cleared);
    assert.equal((await f.call("github_watch_read", { id: watch.id })).pending, 1, "clearing does not erase frozen matches or acknowledge them");
    assert.equal((await f.call("github_delivery_payload", { sequence: secondSequence })).cleared, true);
    assert.equal((await f.send(endpoint, secret, "issues", secondPayload, { deliveryId: secondGuid })).status, 202);
    assert.equal((await f.call("github_delivery_payload", { sequence: secondSequence })).cleared, true, "duplicate redelivery cannot restore an intentionally cleared payload");
    await subscriptions.close(); subscriptions = undefined;
    // Simulate a receipt persisted before the Package API rename. Reopening must
    // preserve its historical owner rather than migrating or replaying it.
    const legacyReceipt = { ...cleared, ownerPackage: "github" };
    const legacy = new DatabaseSync(join(f.root, "github", "github.sqlite"));
    try { legacy.prepare("UPDATE state_receipts SET receipt=? WHERE id=?").run(JSON.stringify(legacyReceipt), clear.requestId); }
    finally { legacy.close(); }
    await f.restart();
    assert.deepEqual((await f.call("github_state_receipt_get", { requestId: clear.requestId })).receipt, legacyReceipt);
    assert.deepEqual(await f.call("github_history_clear", clear), legacyReceipt);
    assert.equal((await f.call("github_watch_read", { id: watch.id })).entries[0].sequence, secondSequence);
    assert.equal((await f.call("github_delivery_payload", { sequence: secondSequence })).cleared, true);
    assert.equal((await lstat(join(f.root, "github", "github.sqlite"))).mode & 0o777, 0o600);
    const record = await f.call<Endpoint>("github_endpoint_get", { id: endpoint.id });
    assert.equal(record.accepted, 3); assert.equal(record.duplicates, 2);
    assert.ok(!JSON.stringify(record).includes(secret));
  } finally { await subscriptions?.close(); await f.close(); }
});

test("intake authenticates original bytes, isolates receiver targets, rotates secrets and accepts non-repository and future events", async () => {
  const f = await fixture();
  const control = installationControlRoot(f.env);
  try {
    const { endpoint, secret } = await f.create();
    for (const [options, status] of [
      [{ signature: "sha256=" + "0".repeat(64) }, 401], [{ signature: "sha1=deadbeef" }, 401],
      [{ raw: "[]" }, 400], [{ raw: "{broken" }, 400], [{ headers: { "content-type": "text/plain" } }, 415],
      [{ headers: { "x-github-event": "issues, push" } }, 400], [{ headers: { "x-github-delivery": "" } }, 400],
    ] as const) assert.equal((await f.send(endpoint, secret, "issues", issue(), options)).status, status);
    assert.equal((await f.send(endpoint, secret, "issues", issue("opened", { repository: { full_name: "another/project" } }))).status, 422);
    const guid = randomUUID();
    const form = await f.send(endpoint, secret, "future_widget", issue(), { form: true, deliveryId: guid });
    assert.equal(form.status, 202);
    const sequence = (await form.json() as { sequence: number }).sequence;
    const summary = await f.call<Delivery>("github_delivery_get", { sequence });
    assert.equal(summary.knownEvent, false); assert.equal(summary.contentType, "application/x-www-form-urlencoded");
    assert.equal((await f.send(endpoint, secret, "future_widget", issue("closed"), { form: true, deliveryId: guid })).status, 409);
    const backfill = await f.call<Watch>("github_watch_create", { id: randomUUID(), label: "Any payload field", start: 0, filter: { predicates: [{ path: "/issue/title", op: "starts_with", value: "Unicode" }, { path: "/issue/missing", op: "exists", value: false }] } });
    assert.equal((await f.call("github_watch_read", { id: backfill.id })).pending, 1);
    const stable = await f.call<Watch>("github_watch_create", { id: randomUUID(), label: "Stable repository identity", filter: { repositoryIds: [3] } });
    const paused = await f.call<Watch>("github_watch_update", { id: stable.id, expectedRevision: stable.revision, enabled: false });
    assert.equal((await f.send(endpoint, secret, "repository", issue("renamed", { repository: { id: 3, full_name: "owner/renamed", name: "renamed", owner: { login: "owner" } } }))).status, 202);
    assert.equal((await f.call("github_watch_read", { id: stable.id })).pending, 1, "paused watches retain arrivals and stable ID filters survive rename");
    await f.call("github_watch_update", { id: stable.id, expectedRevision: paused.revision, enabled: true });
    assert.equal((await f.send(endpoint, secret, "issues", issue("opened", { repository: { id: 4, full_name: "owner/project" } }))).status, 422, "a reused repository name cannot replace the bound signed identity");
    const grace = await f.call<Endpoint>("github_endpoint_secret_rotate", { id: endpoint.id, expectedRevision: 1, graceSeconds: 60 });
    assert.ok(grace.previousSecretExpiresAt);
    assert.equal((await f.send(endpoint, secret, "ping", {})).status, 202);
    await f.call("github_endpoint_secret_rotate", { id: endpoint.id, expectedRevision: grace.revision });
    assert.equal((await f.send(endpoint, secret, "ping", {})).status, 401);
    const current = await f.call("github_endpoint_secret_reveal", { id: endpoint.id, reveal: true });
    assert.equal((await f.send(endpoint, current.secret, "ping", {})).status, 202);
    for (const [target, event, payload] of [
      [{ kind: "organization", organization: "owner" }, "team", { action: "created", organization: { login: "owner" }, team: { id: 5, name: "Maintainers" } }],
      [{ kind: "enterprise", enterprise: "company" }, "business", { action: "updated", enterprise: { slug: "company" } }],
      [{ kind: "app", appId: 9 }, "installation", { action: "created", installation: { id: 55, app_id: 9 } }],
      [{ kind: "marketplace" }, "marketplace_purchase", { action: "purchased", marketplace_purchase: { plan: { id: 7 } } }],
      [{ kind: "sponsors_listing", account: "maintainer" }, "sponsorship", { action: "created", sponsorship: { sponsorable: { login: "maintainer", id: 99 } } }],
    ] as const) {
      const receiver = await f.create(target);
      assert.equal((await f.send(receiver.endpoint, receiver.secret, event, payload)).status, 202);
      assert.equal((await f.send(receiver.endpoint, secret, event, payload)).status, 401, "another receiver's secret cannot authorize intake");
    }
    const latest = await f.call<Endpoint>("github_endpoint_get", { id: endpoint.id });
    await f.call("github_endpoint_update", { id: endpoint.id, expectedRevision: latest.revision, enabled: false });
    assert.equal((await f.send(endpoint, current.secret, "ping", {})).status, 410);
    await assert.rejects(f.call("github_endpoint_secret_reveal", { id: endpoint.id, reveal: true }, caller), /operator/);
    const ghes = await f.call<Endpoint>("github_endpoint_create", { id: randomUUID(), label: "Private GHES", target: { kind: "repository", repository: "team/project" }, githubHost: "git.example.test" });
    const setup = await f.call("github_setup_read", { id: ghes.id });
    assert.equal(setup.settingsUrl, "https://git.example.test/team/project/settings/hooks");
    assert.equal(setup.automatedHookManagement, false);
    await assert.rejects(f.call("github_hook_list", { endpointId: ghes.id }), /manual_setup_required/);
    const organization = await f.create({ kind: "organization", organization: "owner" });
    assert.equal((await f.send(organization.endpoint, organization.secret, "meta", { action: "deleted", hook: { id: 17 } })).status, 202, "signed lifecycle events need not represent the target");
    assert.equal((await f.send(organization.endpoint, organization.secret, "repository", { action: "transferred", repository: { full_name: "outside/project", owner: { login: "outside" } } })).status, 202, "a repository's new owner does not establish the hook's organization");
    const beforeFence = await f.call("github_status");
    const body = JSON.stringify({ action: "deleted", hook: { id: 17 } });
    await mkdir(control, { mode: 0o700 });
    await writeFile(join(control, "fence.json"), JSON.stringify({ version: 1, requestId: randomUUID(), generation: randomUUID(), nextGeneration: randomUUID(), pid: process.pid, browserRevision: "fixture" }), { mode: 0o600 });
    const fenced = await fetch(`http://127.0.0.1:${beforeFence.ingress.port}${organization.endpoint.path}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "meta", "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", organization.secret).update(body).digest("hex")}` }, body });
    assert.ok(fenced.status >= 400, "the shared installation fence denies even valid signed webhook intake");
    await rm(join(control, "fence.json"));
    assert.equal((await f.call("github_status")).latestSequence, beforeFence.latestSequence, "fenced ingress performs no ledger write");
  } finally { await f.close(); await rm(control, { recursive: true, force: true }); }
});

test("large delivery summaries page within the transport budget without skipping arrivals", async () => {
  const f = await fixture();
  try {
    const { endpoint, secret } = await f.create({ kind: "app" });
    const payload = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`entity${index}`, { id: "i".repeat(1000), title: "t".repeat(500), html_url: "https://example.test/" + "u".repeat(2000) }]));
    const sequences: number[] = [];
    for (let count = 0; count < 12; count++) {
      const response = await f.send(endpoint, secret, "future_summary", payload);
      assert.equal(response.status, 202); sequences.push((await response.json() as { sequence: number }).sequence);
    }
    const first = await f.call("github_delivery_list", { limit: 50 });
    assert.ok(first.entries.length < sequences.length, "response-byte capacity must shorten the requested page");
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1_150_000);
    const seen = first.entries.map((entry: Delivery) => entry.sequence);
    let next = first.nextCursor;
    while (next !== null) {
      const page = await f.call("github_delivery_list", { after: next, through: first.through, limit: 50 });
      seen.push(...page.entries.map((entry: Delivery) => entry.sequence)); next = page.nextCursor;
    }
    assert.deepEqual(seen, sequences);
  } finally { await f.close(); }
});

test("full storage refuses admission without losing history and exact cleanup releases only its payload budget", { timeout: 30_000 }, async () => {
  const f = await fixture({ STACK_GITHUB_MAX_PAYLOAD_BYTES: String(25 * 1024 * 1024) });
  try {
    const { endpoint, secret } = await f.create({ kind: "app" });
    const payload = { arbitrary: "x".repeat(13 * 1024 * 1024) };
    const accepted = await f.send(endpoint, secret, "future_payload", payload);
    assert.equal(accepted.status, 202);
    const sequence = (await accepted.json() as { sequence: number }).sequence;
    assert.equal((await f.send(endpoint, secret, "future_payload", payload)).status, 507);
    assert.equal((await f.call("github_status")).latestSequence, sequence);
    const plan = await f.call<StatePlan>("github_history_plan", { sequences: [sequence] });
    await f.call("github_history_clear", { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
    assert.equal((await f.call("github_status")).payloads.bytes, 0);
    assert.equal((await f.call("github_delivery_list")).entries.length, 1, "cleanup retains the original arrival receipt");
    assert.equal((await f.send(endpoint, secret, "future_payload", payload)).status, 202);
    const oversized = { arbitrary: "x".repeat(26 * 1024 * 1024) };
    assert.equal((await f.send(endpoint, secret, "future_payload", oversized)).status, 413);
  } finally { await f.close(); }
});

test("official catalog exposes action/permission guidance and self-contained payload schema without restricting new events", async () => {
  const f = await fixture();
  try {
    const catalog = await f.call("github_event_catalog");
    assert.ok(catalog.entries.length > 60);
    const issues = catalog.entries.find((entry: any) => entry.event === "issues");
    assert.ok(issues.actions.some((entry: any) => entry.action === "opened"));
    assert.ok(issues.summary.includes("permission"));
    assert.ok(issues.supportedWebhookTypes.includes("app"));
    const pulls = catalog.entries.find((entry: any) => entry.event === "pull_request");
    assert.ok(pulls.actions.some((entry: any) => entry.action === "review_requested"), "composed payload schemas retain their actions");
    assert.equal(catalog.entries.find((entry: any) => entry.event === "repository_dispatch").customActions, true);
    assert.ok((await f.call("github_event_catalog", { hookType: "enterprise" })).entries.length > 0, "upstream business type is normalized to enterprise");
    assert.ok((await f.call("github_event_catalog", { hookType: "marketplace" })).entries.some((item: any) => item.event === "marketplace_purchase"));
    assert.ok((await f.call("github_event_catalog", { hookType: "sponsors_listing" })).entries.some((item: any) => item.event === "sponsorship"));
    for (const event of ["push", "workflow_run", "check_run", "pull_request", "discussion", "deployment", "repository_vulnerability_alert", "installation", "security_advisory", "projects_v2_item"]) assert.ok(catalog.entries.some((item: any) => item.event === event), event);
    let text = "", offset = 0;
    while (true) {
      const chunk = await f.call("github_event_schema", { event: "issues", action: "opened", offset, limit: 5000 });
      text += chunk.text; if (chunk.nextOffset === null) break; offset = chunk.nextOffset;
    }
    const bundle = JSON.parse(text);
    assert.ok(bundle.components.schemas[bundle.schema.oneOf[0].$ref.split("/").at(-1)].properties.issue);
    const checkRefs = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) if (key === "$ref") assert.ok(bundle.components.schemas[(child as string).split("/").at(-1)!]); else checkRefs(child);
    };
    checkRefs(bundle);
    const enterprise = await f.call("github_event_catalog", { variant: "ghec" });
    assert.ok(enterprise.entries.length >= catalog.entries.length);
    assert.ok(enterprise.entries.some((item: any) => item.event === "organization_custom_property_values"));
  } finally { await f.close(); }
});

test("remote setup uses reviewed exact-hook plans, native gh stdin and durable non-replaying mutation receipts", { timeout: 30_000 }, async () => {
  const native = await mkdtemp(join(tmpdir(), "stack-gh-native-"));
  await mkdir(join(native, "bin"));
  const file = join(native, "remote.json");
  await writeFile(file, JSON.stringify({ hooks: [{ id: 8, active: true, events: ["push"], config: { url: "https://unrelated.example.com/hook" } }], calls: [], mode: "normal" }));
  // A process fixture models the external GitHub boundary, not Stack's receipts, plan comparison or duplicate fence.
  await writeFile(join(native, "bin", "gh"), `#!${process.execPath}
const fs=require('node:fs');const file=process.env.FIXTURE_GITHUB_REMOTE;const state=JSON.parse(fs.readFileSync(file,'utf8'));const args=process.argv.slice(2);const method=args[args.indexOf('--method')+1];const path=args[args.indexOf('--method')+2];let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
state.calls.push({method,path,args,input});fs.writeFileSync(file,JSON.stringify(state));
if(path==='user'){console.log(JSON.stringify({login:'operator',id:1}));return;}
if(method==='GET'&&path.includes('/deliveries?')){console.log('HTTP/2.0 200 OK\\r\\nLink: <https://api.github.com/repos/owner/project/hooks/17/deliveries?per_page=100&cursor=next%2Bpage>; rel="next"\\r\\n\\r\\n'+JSON.stringify([{id:91,guid:'provider-guid',delivered_at:'2026-10-01T10:00:00Z',redelivery:false,duration:0.1,status:'OK',status_code:202,event:'issues',action:'opened'}]));return;}
if(method==='GET'){console.log(JSON.stringify(state.hooks));return;}
if(state.mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}
if(state.mode==='refused'){console.error('gh: Forbidden (HTTP 403) secret-private-provider-error');process.exitCode=1;return;}
if(state.mode==='unknown'){process.exitCode=1;return;}
if(/\\/(pings|tests|attempts)$/.test(path)){return;}
const body=JSON.parse(input);let changed;if(method==='POST'){changed={id:17,...body};state.hooks.push(changed);}else{changed=state.hooks.find(h=>h.id===Number(path.split('/').at(-1)));Object.assign(changed,body);}
fs.writeFileSync(file,JSON.stringify(state));console.log(JSON.stringify(changed));});
`);
  await chmod(join(native, "bin", "gh"), 0o700);
  const f = await fixture({ PATH: `${join(native, "bin")}:${process.env.PATH}`, FIXTURE_GITHUB_REMOTE: file });
  const state = async () => JSON.parse(await readFile(file, "utf8"));
  try {
    const { endpoint, secret } = await f.create();
    assert.equal((await f.call("github_auth_status")).login, "operator");
    await assert.rejects(f.call("github_hook_plan", { endpointId: endpoint.id }, caller), /operator/);
    const plan = await f.call("github_hook_plan", { endpointId: endpoint.id });
    assert.equal(plan.action, "create");
    assert.equal((await state()).calls.filter((call: any) => call.method === "POST").length, 0);
    const input = { planId: plan.id, requestId: randomUUID() };
    const receipt = await f.call<RemoteReceipt>("github_hook_apply", input);
    assert.equal(receipt.status, "succeeded"); assert.equal(receipt.hookId, 17);
    assert.deepEqual(await f.call("github_hook_apply", input), receipt);
    const observed = await state();
    assert.equal(observed.hooks.length, 2); assert.equal(observed.hooks[0].config.url, "https://unrelated.example.com/hook");
    const mutation = observed.calls.find((call: any) => call.method === "POST");
    assert.ok(!mutation.args.join(" ").includes(secret)); assert.equal(JSON.parse(mutation.input).config.secret, secret);
    await assert.rejects(f.call("github_hook_apply", { planId: plan.id, requestId: randomUUID() }), /plan_missing/);
    const probe = { endpointId: endpoint.id, hookId: 17, requestId: randomUUID() };
    assert.equal((await f.call("github_hook_probe", probe)).status, "succeeded");
    assert.equal((await f.call<Endpoint>("github_endpoint_get", { id: endpoint.id })).lastPingAt, null, "probe admission does not synthesize arrival evidence");
    const attempts = await f.call("github_hook_deliveries", { endpointId: endpoint.id, hookId: 17 });
    assert.equal(attempts.entries[0].guid, "provider-guid"); assert.equal(attempts.nextCursor, "next+page");
    await f.call("github_hook_deliveries", { endpointId: endpoint.id, hookId: 17, cursor: attempts.nextCursor });
    assert.ok((await state()).calls.some((call: any) => call.path.endsWith("cursor=next%2Bpage")), "provider pagination cursor is passed opaquely, not confused with a local sequence");
    const changed = await state(); changed.mode = "unknown"; await writeFile(file, JSON.stringify(changed));
    const update = await f.call("github_hook_plan", { endpointId: endpoint.id, events: ["issues"] });
    const request = { planId: update.id, requestId: randomUUID() };
    const unknown = await f.call<RemoteReceipt>("github_hook_apply", request);
    assert.equal(unknown.status, "unknown"); assert.equal(unknown.error, "github_gh_request_failed");
    const callCount = (await state()).calls.length;
    await f.restart();
    assert.deepEqual(await f.call("github_hook_apply", request), unknown); assert.equal((await state()).calls.length, callCount);
    await assert.rejects(f.call("github_hook_apply", { ...request, planId: randomUUID() }), /request_id_conflict/);
    assert.ok(!JSON.stringify(unknown).includes(secret));
    const hanging = await state(); hanging.mode = "hang"; await writeFile(file, JSON.stringify(hanging));
    const stopProbe = { endpointId: endpoint.id, hookId: 17, requestId: randomUUID() };
    const inFlight = f.call<RemoteReceipt>("github_hook_probe", stopProbe);
    const beforeStop = hanging.calls.length;
    await until(async () => (await state()).calls.length > beforeStop);
    await f.restart();
    const stopped = await inFlight;
    assert.equal(stopped.status, "unknown", "shutdown drains and fences native calls even when the child ignores SIGTERM");
    const afterStop = (await state()).calls.length;
    assert.deepEqual(await f.call("github_hook_probe", stopProbe), stopped);
    assert.equal((await state()).calls.length, afterStop, "owner restart never redispatches interrupted effects");
  } finally { await f.close(); await rm(native, { recursive: true, force: true }); }
});
