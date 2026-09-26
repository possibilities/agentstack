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
const { WorkerAccountsWindow } = await import("../components/canvas/windows.tsx");
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
function render(Component, { accounts, logins = [], usage = null, runtimes = [], state = {} }) {
  const snapshot = { owner: resource(null), accounts: resource([]), workerAccounts: resource(accounts), workerRuntimes: resource(runtimes),
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
  const html = render(WorkerAccountsWindow, { accounts, logins: [login] });
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
  const failed = render(WorkerAccountsWindow, { accounts, logins: [{ ...login, status: "failed", needsCode: false }] });
  assert.match(card(failed, "worker-account:claude-a"), /role="alert"/);
  assert.match(text(failed), /Try again/);
  const waiting = render(WorkerAccountsWindow, { accounts, logins: [{ ...login, needsCode: false, error: null }] });
  assert.match(text(waiting), /finish signing in/);
  assert.doesNotMatch(text(waiting), /enter this code|paste/);
});

test("Claude usage shows per-account windows, resets, provider-unit extra usage and unobserved accounts", () => {
  const accounts = [account("claude-a"), account("claude-b", { enabled: false, ready: false })];
  const observedAtMs = Date.now() - 600_000;
  const lastAttemptAtMs = Date.now();
  const measured = (extraUsage) => ({ windows: [
    { id: "five_hour", label: "5h", usedPercent: 23, remainingPercent: 77, resetsAt: "2026-09-26T18:00:00Z" },
    { id: "seven_day", label: "Weekly", usedPercent: 100, remainingPercent: 0, resetsAt: null }], extraUsage });
  const usage = (extraUsage) => ({ atMs: lastAttemptAtMs, inventoryAtMs: lastAttemptAtMs, inventoryError: null, grokBot: null,
    accounts: accounts.map((item, index) => ({ ...item, scope: "worker", observedAtMs: index ? null : observedAtMs, lastAttemptAtMs, fresh: false,
      error: index ? "credentials_unavailable" : "provider_unavailable", usage: index ? null : measured(extraUsage) })) });
  const html = render(UsageWindow, { accounts, usage: usage({ enabled: true, monthlyLimit: 5000, usedCredits: 120, utilization: 2.4 }) });
  const first = card(html, "usage-account:worker:claude-a");
  assert.match(first, /aria-label="Inspect claude-worker-account-1 usage"/);
  assert.match(first, /aria-label="Read failed"/);
  assert.match(first, /aria-label="claude-worker-account-1 5h remaining"[^>]*aria-valuenow="77"/);
  assert.match(first, /aria-label="claude-worker-account-1 Weekly remaining"[^>]*aria-valuenow="0"/);
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

test("Claude catalog renders SDK evidence and stale/unavailable states without ACP claims", () => {
  const accounts = [account("claude-a"), account("claude-b", { enabled: false }), account("claude-c", { ready: false })];
  const catalog = (accountId) => ({ accountId, provider: "claude", observedAt: new Date().toISOString(), source: "claude-sdk-supported-models",
    runtimeVersion: "0.3.283", modelConfigId: "model", models: [{ id: "claude-sonnet-fixture", name: "Claude Sonnet fixture", efforts: ["low", "high"], effortConfigId: "effort" }],
    nativeModelIds: [], stale: false, error: null });
  const state = { status: { workers: "open" }, workerCatalogs: { "claude-a": resource(catalog("claude-a")), "claude-b": resource(catalog("claude-b")) } };
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
