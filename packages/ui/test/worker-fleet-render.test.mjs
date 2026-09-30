import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the actual client components without a Next build, sockets, or a browser.
// Use Next's installed TSX compiler so this introduces no test dependency.
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc");
await swc.loadBindings();
const root = new URL("../", import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/") || (context.parentURL?.startsWith(root.href) && specifier.startsWith(".") && !extname(specifier))) {
      const base = specifier.startsWith("@/") ? new URL(specifier.slice(2), root) : new URL(specifier, context.parentURL);
      const resolved = ["", ".ts", ".tsx"].map((suffix) => new URL(`${base.href}${suffix}`)).find((url) => existsSync(url));
      if (resolved) return next(resolved.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith(".tsx")) return { format: "module", shortCircuit: true,
      source: swc.transformSync(readFileSync(new URL(url), "utf8"), { filename: fileURLToPath(url),
        jsc: { parser: { syntax: "typescript", tsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } }, module: { type: "es6" } }).code };
    return next(url, context);
  },
});

const { StackProvider, WorkbenchContext, useStore } = await import("../components/canvas/provider.tsx");
const { PlacementContext } = await import("../components/canvas/window.tsx");
const { AuthActionsProvider } = await import("../components/canvas/auth-actions.tsx");
const { AccountsWindow } = await import("../components/canvas/windows.tsx");
const { ObservationStatus, UsageWindow } = await import("../components/canvas/usage-window.tsx");
const { CatalogWindow } = await import("../components/canvas/catalog-window.tsx");
const { TooltipProvider } = await import("../components/ui/tooltip.tsx");
const resource = (data) => ({ data, error: null, at: Date.now() });
const account = (id, extra = {}) => ({ id, provider: "claude", ready: true, enabled: true, removing: false, linkedAccounts: [], ...extra });
const noop = () => {};
const placement = () => ({ x: 0, y: 0, z: 1, width: 400, height: 900, collapsed: false, animating: false, dragging: false,
  onHeaderPointerDown: noop, onFocusWithin: noop, onToggleCollapse: noop, register: noop });
const workbench = { space: "fleet", selected: null, hovered: null, flash: null, setSpace: noop, select: noop, hover: noop, goTo: noop };
function Seed({ state, children }) {
  Object.assign(useStore().getState(), state);
  return children;
}
function render(Component, { accounts, bots = [], logins = [], usage = null, runtimes = [], state = {} }) {
  const snapshot = { server: resource(null), resources: resource(null), accounts: resource(bots), workerAccounts: resource(accounts), workerRuntimes: resource(runtimes),
    workerSessions: resource([]), login: resource(null), workerLogins: resource(logins), bots: resource([]), botDefaults: resource(null),
    voice: resource(null), catalog: resource([]), usage: resource(usage), endpoints: {} };
  return renderToStaticMarkup(h(StackProvider, { snapshot }, h(Seed, { state },
    h(WorkbenchContext, { value: workbench }, h(PlacementContext, { value: placement }, h(TooltipProvider, null,
      h(AuthActionsProvider, null, h(Component))))))));
}
const text = (html) => html.replace(/<[^>]+>/g, "");
const card = (html, key, tag = "article") => {
  const result = html.match(new RegExp(`<${tag}\\b[^>]*data-node="${key}"[^>]*>[\\s\\S]*?<\\/${tag}>`))?.[0];
  assert.ok(result, `Missing ${key}`);
  return result;
};

test("Claude native sign-ins render independent accessible paste-code, recovery and disabled account states", () => {
  const accounts = [account("claude-a", { ready: false }), account("claude-b", { enabled: false })];
  const login = { id: "attempt-a", account: accounts[0].id, provider: "claude", status: "pending", authUrl: "https://claude.ai/oauth/authorize?fixture",
    userCode: null, needsCode: true, error: "The code was rejected. Paste a new code from Claude." };
  const html = render(AccountsWindow, { accounts, logins: [login] });
  const first = card(html, "worker-account:claude-a");
  const second = card(html, "worker-account:claude-b");
  assert.match(first, /aria-label="Inspect worker account claude-worker-account-1"/);
  assert.match(first, /aria-label="Submit Claude sign-in code"/);
  assert.match(first, /aria-invalid="true"/);
  assert.match(text(first), /Code from Claude/);
  assert.match(text(first), /paste Claude’s code here/);
  assert.match(text(first), /Waiting for code/);
  assert.match(text(first), /Needs sign-in/);
  assert.match(text(first), /The code was rejected/);
  assert.doesNotMatch(first, /href="https:\/\/claude.ai|window.open/);
  assert.match(second, /aria-label="Inspect worker account claude-worker-account-2"/);
  assert.match(text(second), /Disabled/);
  assert.match(text(second), /Enable/);
  assert.doesNotMatch(second, /attempt-a|Submit code|Waiting for code/);
  assert.doesNotMatch(html, /Devin|ACP/);
  const failed = render(AccountsWindow, { accounts, logins: [{ ...login, status: "failed", needsCode: false }] });
  assert.match(card(failed, "worker-account:claude-a"), /role="alert"/);
  assert.match(text(failed), /Try again/);
  const waiting = render(AccountsWindow, { accounts, logins: [{ ...login, needsCode: false, error: null }] });
  assert.match(text(waiting), /finish signing in/);
  assert.doesNotMatch(text(waiting), /enter this code|paste/);
});

test("one Accounts window joins each Codex Bot account to its Worker and keeps placeholders to a title", () => {
  const bot = { id: "bot-a", enabled: true, removing: false, linkedAccounts: [{ scope: "worker", id: "codex-w" }] };
  const accounts = [account("codex-w", { provider: "codex", ready: false, linkedAccounts: [{ scope: "bot", id: "bot-a" }] }), account("devin-a", { provider: "devin" })];
  const html = render(AccountsWindow, { accounts, bots: [bot] });
  const pair = html.match(/<div role="group" aria-label="codex-bot-account-1 and its Worker account"[\s\S]*?<\/article><article[\s\S]*?<\/article>/)?.[0];
  assert.ok(pair, "the Codex pair renders as one group");
  assert.match(pair, /data-node="account:bot-a"/);
  assert.match(pair, /data-node="worker-account:codex-w"/);
  assert.match(text(card(html, "account:bot-a")), /Ready/);
  assert.match(text(card(html, "worker-account:codex-w")), /Needs sign-in/);
  assert.match(text(html), /CodexDevin|Codex.*Devin/);
  assert.match(html, /Add account/);
  assert.doesNotMatch(text(html), /Paired with|Same login as|Enabled/);
  const empty = render(AccountsWindow, { accounts: [] });
  assert.match(text(empty), /No accounts/);
  assert.doesNotMatch(text(empty), /Sign in with|to add one/);
});

test("a duplicate Codex sign-in explains the rejection without showing a new account", () => {
  const duplicate = { id: "attempt-duplicate", account: null, targetAccount: null, status: "failed", authUrl: null, userCode: null,
    error: "This ChatGPT login is already registered as a Codex Bot account. Choose a different login, or use Sign in again on the existing account." };
  const failed = render(AccountsWindow, { accounts: [], state: { attempt: duplicate } });
  assert.match(text(failed), /New Codex Bot account/);
  assert.match(text(failed), /already registered as a Codex Bot account/);
  assert.match(text(failed), /Sign in again on the existing account/);
  assert.doesNotMatch(failed, /data-node="account:/);
  const pending = render(AccountsWindow, { accounts: [], state: { attempt: { ...duplicate, status: "pending", error: null,
    authUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } } });
  assert.match(text(pending), /A duplicate sign-in won’t create another account/);
});

test("Claude usage shows per-account windows, resets, provider-unit extra usage and unobserved accounts", () => {
  const accounts = [account("claude-a"), account("claude-b", { enabled: false, ready: false })];
  const observedAtMs = Date.now() - 600_000;
  const lastAttemptAtMs = Date.now();
  const measured = (extraUsage) => ({ windows: [
    { id: "five_hour", label: "5h", usedPercent: 23, remainingPercent: 77, resetsAt: "2026-09-26T18:00:00Z" },
    { id: "seven_day", label: "Weekly", usedPercent: 100, remainingPercent: 0, resetsAt: null }], extraUsage });
  const usage = (extraUsage) => ({ atMs: lastAttemptAtMs, inventoryAtMs: lastAttemptAtMs, inventoryError: null,
    accounts: accounts.map((item, index) => ({ ...item, scope: "worker", observedAtMs: index ? null : observedAtMs, lastAttemptAtMs, fresh: false,
      error: index ? "credentials_unavailable" : "provider_unavailable", usage: index ? null : measured(extraUsage) })) });
  const html = render(UsageWindow, { accounts, usage: usage({ enabled: true, monthlyLimit: 5000, usedCredits: 120, utilization: 2.4 }) });
  const first = card(html, "usage-account:worker:claude-a");
  assert.match(first, /aria-label="Inspect claude-worker-account-1 usage"/);
  assert.match(first, /aria-label="Read failed"/);
  // The exhausted weekly window blocks the 5h headroom: it keeps its tone but dims.
  assert.match(first, /aria-label="claude-worker-account-1 5h remaining, unavailable until Weekly resets"[^>]*aria-valuenow="77"[^>]*opacity-35/);
  assert.match(first, /aria-label="claude-worker-account-1 Weekly remaining"[^>]*aria-valuenow="0"/);
  assert.match(text(first), /5h77%/);
  // Bars fill with usage, like the providers' own: 77% remaining fills 23%, an exhausted window fills fully.
  assert.match(first, /aria-valuenow="77"[^>]*><span[^>]*width:23%/);
  assert.match(first, /aria-valuenow="0"[^>]*><span[^>]*bg-destructive[^>]*width:100%/);
  assert.match(text(first), /Weekly0%—/);
  assert.doesNotMatch(text(first), /remaining/);
  assert.match(first, /title="2026-09-26T18:00:00Z"/);
  assert.match(text(first), /extra usage 120 \/ 5,000 credits/);
  assert.doesNotMatch(text(first), /\$/);
  const second = card(html, "usage-account:worker:claude-b", "span");
  assert.match(second, /title="credentials_unavailable"/);
  assert.doesNotMatch(second, /77%|extra usage/);
  const off = card(render(UsageWindow, { accounts, usage: usage({ enabled: false, monthlyLimit: null, usedCredits: 0, utilization: null }) }), "usage-account:worker:claude-a");
  assert.match(text(off), /extra usage off/);
  const unreported = card(render(UsageWindow, { accounts, usage: usage(null) }), "usage-account:worker:claude-a");
  assert.doesNotMatch(text(unreported), /extra usage/);
  const status = render(() => h(ObservationStatus, { observation: usage(null).accounts[0] }), { accounts });
  assert.match(text(status), /stale10m ago· tried/);
  assert.match(text(status), /provider_unavailable · showing last good read/);
});

test("Exhausted Devin quota reads Limit and stale measurements keep their age visible", () => {
  const accounts = [account("devin-a", { provider: "devin" })];
  const at = Date.now();
  const observation = { observedAtMs: at, lastAttemptAtMs: at, fresh: true, error: null };
  const devin = { planLabel: "Pro", billing: "quota", dailyRemainingPercent: 100, weeklyRemainingPercent: 0, dailyResetsAt: null, weeklyResetsAt: null,
    periodStart: null, periodEnd: null, promptCreditsMonthly: -1, promptCreditsAvailable: -1, weeklyQuotaHidden: null, displayName: null };
  const snapshot = { atMs: at, inventoryAtMs: at, inventoryError: null,
    accounts: [{ ...accounts[0], scope: "worker", ...observation, usage: devin }] };
  const html = render(UsageWindow, { accounts, usage: snapshot });
  const devinCard = card(html, "usage-account:worker:devin-a");
  assert.match(devinCard, />Limit</);
  assert.match(devinCard, /aria-label="devin-worker-account-1 daily remaining, unavailable until weekly resets"[^>]*opacity-35/);
  assert.match(devinCard, /aria-label="devin-worker-account-1 weekly remaining"[^>]*class="(?![^"]*opacity-35)/);
  const staleDevin = render(UsageWindow, { accounts: [accounts[0]], usage: {
    ...snapshot, accounts: [{ ...snapshot.accounts[0], observedAtMs: at - 13 * 60_000, fresh: false }],
  } });
  const staleCard = card(staleDevin, "usage-account:worker:devin-a");
  assert.match(text(staleCard), /updated 13m ago/);
  assert.match(staleCard, /<p class="flex min-w-0 items-baseline gap-2 text-\[0\.68rem\] text-muted-foreground"><span class="shrink-0 text-foreground\/80">updated /);
});

test("Usage groups interleaved provider observations and unobserved accounts in Accounts order", () => {
  const at = Date.now();
  const observation = { observedAtMs: at, lastAttemptAtMs: at, fresh: true, error: null };
  const workers = [account("claude-a"), account("devin-a", { provider: "devin" }),
    account("codex-w", { provider: "codex", linkedAccounts: [{ scope: "bot", id: "codex-b" }] }),
    account("devin-b", { provider: "devin", ready: false }), account("claude-b", { ready: false })];
  const botAccount = { id: "codex-b", provider: "codex", linkedAccounts: [{ scope: "worker", id: "codex-w" }] };
  const measured = (item) => ({ ...item, scope: "worker", ...observation, usage: item.id === "devin-b" || item.id === "claude-b" ? null
    : item.provider === "claude" ? { windows: [], extraUsage: null }
    : item.provider === "devin" ? { planLabel: null, dailyRemainingPercent: null, weeklyRemainingPercent: null,
      weeklyQuotaHidden: false, promptCreditsAvailable: null, promptCreditsMonthly: null }
    : { planType: null, limitReached: false, resetCreditsAvailable: 0, lanes: [] } });
  const usage = { atMs: at, inventoryAtMs: at, inventoryError: null,
    // Deliberately interleave providers in an order different from Accounts.
    accounts: [measured(workers[0]), measured(workers[1]), measured(workers[2]),
      { ...botAccount, scope: "bot", ...observation, usage: { planType: "Pro", limitReached: false, resetCreditsAvailable: 0, lanes: [] } },
      measured(workers[3]), measured(workers[4])] };
  const html = render(UsageWindow, { accounts: workers, bots: [botAccount], usage });
  const inOrder = ["<h3", "data-node=\"usage-account:bot:codex-b\"", "<h3", "data-node=\"usage-account:worker:devin-a\"", "data-node=\"usage-account:worker:devin-b\"",
    "<h3", "data-node=\"usage-account:worker:claude-a\"", "data-node=\"usage-account:worker:claude-b\""];
  let position = -1;
  for (const marker of inOrder) {
    position = html.indexOf(marker, position + 1);
    assert.notEqual(position, -1, `Missing or out of order: ${marker}`);
  }
  assert.deepEqual([...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]), ["Codex", "Devin", "Claude"]);
  assert.equal((html.match(/data-node="usage-account:worker:codex-w"/g) ?? []).length, 1, "paired Worker stays in the Codex Bot card");
});

test("Claude catalog renders SDK evidence and stale/unavailable states without ACP claims", () => {
  const accounts = [account("claude-a"), account("claude-b", { enabled: false }), account("claude-c", { ready: false })];
  const catalog = (accountId) => ({ accountId, provider: "claude", observedAt: new Date().toISOString(), source: "claude-sdk-supported-models",
    runtimeVersion: "0.3.283", modelConfigId: "model", models: [{ id: "claude-sonnet-fixture", name: "Claude Sonnet fixture", efforts: ["low", "high"], effortConfigId: "effort" }],
    nativeModelIds: [], stale: false, error: null });
  const state = { status: { worker: "open" }, workerCatalogs: { "claude-a": resource(catalog("claude-a")), "claude-b": resource(catalog("claude-b")) } };
  const runtimes = accounts.map((item) => ({ id: item.id, provider: "claude", backend: "claude-sdk", processModel: "session", pids: [], state: "running", pid: null, instance: "fixture", error: null }));
  const html = render(CatalogWindow, { accounts, runtimes, state });
  for (const label of ["claude-worker-account-1", "claude-worker-account-2", "claude-worker-account-3"]) assert.match(text(html), new RegExp(label));
  assert.match(html, /aria-selected="true"[^>]*data-node="worker-catalog:claude-a"/);
  assert.match(html, /title="claude-sdk-supported-models · 0.3.283"/);
  assert.match(text(html), /observed.*0\.3\.283.*Claude Sonnet fixture/);
  assert.match(html, /aria-label="Efforts: low, high"/);
  assert.doesNotMatch(html, /ACP|Devin|stale/);
  const disabled = render(CatalogWindow, { accounts: [accounts[1]], runtimes, state });
  assert.match(text(disabled), /stale.*Enable to see models/);
  assert.match(text(render(CatalogWindow, { accounts: [accounts[2]], runtimes, state })), /Sign in to see models/);
  state.workerCatalogs["claude-a"].data.error = "catalog_unavailable";
  const failed = render(CatalogWindow, { accounts, runtimes, state });
  assert.match(text(failed), /stale.*catalog_unavailable.*Claude Sonnet fixture/);
  // An identical, equally available catalog joins the first account's tab instead of adding its own.
  state.workerCatalogs["claude-a"].data.error = null;
  const twins = [accounts[0], account("claude-d")];
  state.workerCatalogs["claude-d"] = resource(catalog("claude-d"));
  const stacked = render(CatalogWindow, { accounts: twins, runtimes: [...runtimes, { ...runtimes[0], id: "claude-d" }], state });
  assert.equal(stacked.match(/role="tab"/g).length, 1);
  assert.match(stacked, /aria-selected="true"[^>]*data-node="worker-catalog:claude-a"[\s\S]*data-node="worker-catalog:claude-d"[^>]*>claude-worker-account-2/);
  assert.match(stacked, /aria-label="Inspect claude-worker-account-2 model catalog"/);
  state.workerCatalogs["claude-d"].data.models = [];
  assert.equal(render(CatalogWindow, { accounts: twins, runtimes: [...runtimes, { ...runtimes[0], id: "claude-d" }], state }).match(/role="tab"/g).length, 2);
});
