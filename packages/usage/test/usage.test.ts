import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { accountSubscription, collectAccount } from "../src/collect.js";
import { UsageObserver, type Registered } from "../src/observer.js";
import { snapshotSchema } from "../src/schema.js";

const codexId = "00000000-0000-4000-8000-000000000001";
const devinId = "00000000-0000-4000-8000-000000000003";
const codexUsage = { planType: "pro", limitReached: false, resetCreditsAvailable: null, resetCreditExpirations: null, lanes: [] };
const devinUsage = { planLabel: "Pro", billing: "quota", dailyRemainingPercent: 76, weeklyRemainingPercent: 54,
  dailyResetsAt: null, weeklyResetsAt: null, periodStart: null, periodEnd: "2026-10-23T02:47:53.000Z",
  promptCreditsMonthly: 100, promptCreditsAvailable: null, weeklyQuotaHidden: null, displayName: null };

test("observes each registered account with its own credentials and projects only usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-usage-"));
  try {
    const secrets = join(root, "secrets.sqlite");
    const db = new DatabaseSync(secrets);
    db.exec("CREATE TABLE credentials (name TEXT, auth_json TEXT)");
    db.prepare("INSERT INTO credentials VALUES (?, ?)").run(codexId, JSON.stringify({ tokens: {
      access_token: "codex-secret", account_id: "native-codex", refresh_token: "never-publish",
      id_token: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
        chatgpt_subscription_active_until: "2026-09-30T15:22:09+00:00", chatgpt_subscription_last_checked: "2026-09-26T01:27:38.866955+00:00",
      } })).toString("base64url")}.sig`,
    } }));
    db.close();
    await chmod(secrets, 0o600);
    const workerPath = join(root, "worker-accounts", codexId, "data/opencode/opencode.db");
    await mkdir(join(workerPath, ".."), { recursive: true });
    const workerDb = new DatabaseSync(workerPath);
    workerDb.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
    workerDb.prepare("INSERT INTO credential VALUES (?, ?)").run("openai", JSON.stringify({ type: "oauth",
      access: "codex-worker-secret", refresh: "never-publish", metadata: { accountID: "native-worker" } }));
    workerDb.close();
    await chmod(workerPath, 0o600);
    const devinPath = join(root, "worker-accounts", devinId, "data/devin/credentials.toml");
    await mkdir(join(devinPath, ".."), { recursive: true });
    await writeFile(devinPath, 'windsurf_api_key = "devin-secret"\napi_server_url = "https://example.devin.ai"\n', { mode: 0o600 });
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      assert.notEqual((init?.headers as Record<string, string>)?.authorization, "Bearer never-publish");
      if (url.endsWith("/wham/usage")) {
        const headers = init?.headers as Record<string, string>;
        const worker = headers.authorization === "Bearer codex-worker-secret";
        assert.equal(headers["ChatGPT-Account-ID"], worker ? "native-worker" : "native-codex");
        return Response.json({ plan_type: "pro", rate_limit: { primary_window: {
          used_percent: worker ? 34 : 12, limit_window_seconds: 18000, reset_after_seconds: 200,
        } }, additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 88 } } }] });
      }
      assert.ok(url.endsWith("/GetUserStatus"));
      assert.equal(JSON.parse(String(init?.body)).metadata.apiKey, "devin-secret");
      return Response.json({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 76, weeklyQuotaRemainingPercent: 54,
        planEnd: "2026-10-23T02:47:53Z", planInfo: { planName: "Pro", billingStrategy: "BILLING_STRATEGY_QUOTA", monthlyPromptCredits: 100 } } } });
    };
    const results = await Promise.all([collectAccount(root, codexId, "codex", fetcher), collectAccount(root, devinId, "devin", fetcher)]);
    const workerUsage = await collectAccount(root, codexId, "codex", fetcher, undefined, "worker");
    assert.equal((results[0] as { lanes: Array<{ windows: Array<{ usedPercent: number }> }> }).lanes[0]?.windows[0]?.usedPercent, 12);
    assert.equal((workerUsage as { lanes: Array<{ windows: Array<{ usedPercent: number }> }> }).lanes[0]?.windows[0]?.usedPercent, 34);
    assert.equal(await accountSubscription(root, codexId, "codex", "worker"), null);
    assert.deepEqual(await accountSubscription(root, codexId, "codex", "bot"),
      { endsAt: "2026-09-30T15:22:09.000Z", source: "sign_in_claim", checkedAtMs: Date.parse("2026-09-26T01:27:38.866Z") });
    assert.equal((results[1] as { dailyRemainingPercent: number }).dailyRemainingPercent, 76);
    assert.equal((results[1] as { periodEnd: string | null }).periodEnd, "2026-10-23T02:47:53.000Z");
    assert.equal(seen.length, 3);
    assert.ok(!JSON.stringify(results).includes("secret"));
    assert.ok(!JSON.stringify(results).includes("native-codex"));
    await rm(devinPath);
    await symlink(secrets, devinPath);
    await assert.rejects(collectAccount(root, devinId, "devin", fetcher), /credentials_unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("clearing a scoped observation fences an in-flight result and persists without clearing its sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-usage-clear-"));
  let release!: (value: typeof codexUsage) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const observer = new UsageObserver(root, {}, async () => ["worker", "bot"].map(scope => ({ id: codexId,
    scope: scope as "bot" | "worker", provider: "codex", enabled: true, ready: true, removing: false })),
  async (_id, _provider, scope) => { if (scope === "worker") return codexUsage; entered(); return new Promise(resolve => { release = resolve; }); }, async () => null);
  try {
    const collecting = observer.cycle(); await started;
    const plan = observer.clearPlan({ accounts: [{ id: codexId, scope: "bot" }] });
    const input = { planId: plan.id, expectedRevision: plan.revision, requestId: crypto.randomUUID() };
    assert.equal((await observer.clear(input)).status, "completed");
    release(codexUsage); await collecting;
    assert.equal(observer.snapshot().accounts.find(row => row.scope === "bot")!.usage, null);
    assert.deepEqual(observer.snapshot().accounts.find(row => row.scope === "worker")!.usage, codexUsage);
    assert.equal((await observer.clear(input)).status, "completed");
    const restored = new UsageObserver(root); await restored.load();
    try { assert.equal(restored.snapshot().accounts.find(row => row.scope === "bot")!.usage, null); }
    finally { await restored.close(); }
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("owner observer keeps last-good records, removes deleted accounts and paces retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-usage-"));
  let available = true, successes = true, calls = 0, changes = 0;
  const observer = new UsageObserver(root, {}, async () => available ? [
    { id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false },
    { id: devinId, scope: "worker", provider: "devin", enabled: false, ready: true, removing: false },
  ] : [], async (_id, provider) => { calls++; if (!successes) throw new Error("provider echoed private credentials");
    return provider === "codex" ? codexUsage : devinUsage; }, async () => null);
  try {
    observer.onChange = () => changes++;
    await observer.cycle();
    let snapshot = observer.snapshot();
    assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(snapshot.accounts[0]?.fresh, true);
    assert.ok(snapshot.accounts[1]?.usage);
    assert.equal(snapshot.accounts[1]?.enabled, false);
    assert.equal(calls, 2); assert.equal(changes, 1);
    await observer.cycle(); assert.equal(calls, 2);
    const restored = new UsageObserver(root);
    try { await restored.load(); assert.equal(restored.snapshot().accounts.length, 2); assert.equal(restored.snapshot().accounts[0]?.fresh, false); }
    finally { await restored.close(); }
    assert.ok(!(await readFile(join(root, "usage/observations.json"), "utf8")).includes("provider echoed private credentials"));
    successes = false;
    await observer.cycle(Date.now() + 181_000);
    snapshot = observer.snapshot();
    assert.equal(snapshot.accounts[0]?.error, "observation_failed");
    assert.equal(snapshot.accounts[0]?.fresh, false); assert.ok(snapshot.accounts[0]?.usage); assert.equal(calls, 4);
    available = false; await observer.cycle(); assert.equal(observer.snapshot().accounts.length, 0);
    const afterRemoval = new UsageObserver(root);
    try { await afterRemoval.load(); assert.equal(afterRemoval.snapshot().accounts.length, 0); }
    finally { await afterRemoval.close(); }
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("usage repeats auth's scoped Bot–Worker pairing, including a Worker awaiting sign-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-usage-links-"));
  let workerReady = true, paired = true;
  // An overlapping legacy UUID must still be two independent scoped records.
  const observer = new UsageObserver(root, {}, async () => [
    { id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false,
      linkedAccounts: paired ? [{ scope: "worker", id: codexId }] : [] },
    { id: codexId, scope: "worker", provider: "codex", enabled: true, ready: workerReady, removing: false,
      linkedAccounts: paired ? [{ scope: "bot", id: codexId }] : [] },
  ], async (_id, _provider, scope) => ({ ...codexUsage, planType: scope }),
  async (_id, _provider, scope) => scope === "bot" ? { endsAt: "2026-09-30T15:22:09.000Z", source: "sign_in_claim", checkedAtMs: 1 } : null);
  try {
    await observer.cycle();
    const rows = observer.snapshot().accounts;
    assert.deepEqual(rows.map(({ scope, linkedAccounts }) => ({ scope, linkedAccounts })), [
      { scope: "bot", linkedAccounts: [{ scope: "worker", id: codexId }] }, { scope: "worker", linkedAccounts: [{ scope: "bot", id: codexId }] },
    ]);
    assert.deepEqual(rows.map(row => row.subscription?.endsAt ?? null), ["2026-09-30T15:22:09.000Z", null]);
    assert.equal(rows[0]?.provider === "codex" ? rows[0].usage?.planType : null, "bot");
    assert.equal(rows[1]?.provider === "codex" ? rows[1].usage?.planType : null, "worker");
    const snapshot = observer.snapshot();
    assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
    workerReady = false; await observer.cycle(); assert.deepEqual(observer.snapshot().accounts.map(row => row.linkedAccounts.length), [1, 1]);
    paired = false; await observer.cycle(); assert.deepEqual(observer.snapshot().accounts.map(row => row.linkedAccounts), [[], []]);
    const restored = new UsageObserver(root);
    try { await restored.load(); assert.equal(restored.snapshot().accounts.length, 2); assert.deepEqual(restored.snapshot().accounts.map(row => row.linkedAccounts), [[], []]); }
    finally { await restored.close(); }
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("an auth account change re-reads the inventory without waiting for the next observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-usage-invalidate-"));
  let removed = false, notify: () => void = () => undefined, closeWatch: () => void = () => undefined;
  const closed = new Promise<void>(resolve => { closeWatch = resolve; });
  const observer = new UsageObserver(root, {}, async () => [
    { id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false },
    { id: devinId, scope: "worker", provider: "devin", enabled: true, ready: true, removing: removed },
  ], async () => null, async () => null,
  async onChange => { notify = onChange; return { topics: ["accounts_changed", "worker_accounts_changed"], closed, close: async () => closeWatch() }; });
  const changed = () => new Promise<void>(resolve => { observer.onChange = resolve; });
  try {
    const first = changed(); observer.start(); await first; assert.equal(observer.snapshot().accounts.length, 2);
    removed = true; const pruned = changed(); notify(); await pruned;
    assert.deepEqual(observer.snapshot().accounts.map(row => row.id), [codexId]);
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy observations retain unsupported data without publishing or collecting it", async () => {
  for (const schemaVersion of [1, 2, 3]) {
    const root = await mkdtemp(join(tmpdir(), "stack-usage-retired-"));
    const path = join(root, "usage/observations.json");
    const measurement = { observedAtMs: null, lastAttemptAtMs: null, error: null, usage: null };
    const retired = { id: "00000000-0000-4000-8000-000000000002", provider: "grok", enabled: true, ready: true,
      ...(schemaVersion > 1 ? { scope: "worker" } : {}), measurement: { ...measurement, usage: { historical: true } }, nextAttemptAtMs: 0 };
    const bot = { ...measurement, usage: { historical: "machine CLI observation" } };
    const observer = new UsageObserver(root, {}, async () => [
      { ...retired, scope: "worker", removing: false },
      { id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false },
    ] as unknown as Registered[], async (_id, provider) => { assert.equal(provider, "codex"); return codexUsage; }, async () => null);
    try {
      await mkdir(join(root, "usage"), { recursive: true });
      await writeFile(path, JSON.stringify({ schemaVersion, accounts: [retired,
        { id: codexId, provider: "codex", scope: "bot", enabled: true, ready: true, measurement, nextAttemptAtMs: 0 }], bot }), { mode: 0o600 });
      await observer.load(); assert.deepEqual(observer.snapshot().accounts.map(row => row.id), [codexId]);
      await observer.cycle();
      const snapshot = observer.snapshot(); assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
      assert.deepEqual(snapshot.accounts.map(row => row.id), [codexId]);
      assert.equal(Object.hasOwn(snapshot, "grokBot"), false);
      const persisted = JSON.parse(await readFile(path, "utf8"));
      assert.equal(persisted.schemaVersion, 4);
      assert.deepEqual(persisted.accounts.find((row: { id: string }) => row.id === retired.id), retired);
      assert.deepEqual(persisted.bot, bot);
      const restored = new UsageObserver(root);
      try { await restored.load(); assert.deepEqual(restored.snapshot().accounts.map(row => row.id), [codexId]); }
      finally { await restored.close(); }
    } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("a Devin plan period end is its subscription end, checked when measured", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-usage-devin-subscription-"));
  const observer = new UsageObserver(root, {}, async () => [{ id: devinId, scope: "worker", provider: "devin", enabled: true, ready: true, removing: false }],
    async () => devinUsage, async () => null);
  try {
    await observer.cycle(); const [row] = observer.snapshot().accounts;
    assert.deepEqual(row?.subscription, { endsAt: "2026-10-23T02:47:53.000Z", source: "plan_period", checkedAtMs: row?.observedAtMs });
    const restored = new UsageObserver(root);
    try { await restored.load(); assert.deepEqual(restored.snapshot().accounts[0]?.subscription, row?.subscription); }
    finally { await restored.close(); }
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});
