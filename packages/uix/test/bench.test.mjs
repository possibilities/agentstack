// Open bench geometry, navigation and transport-reference contracts.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { snap, snapLocal, snapSize, gridSize, validSize, packSpaces, localLayout, boundsOf, preserveAnchor, fitBounds, reconcileBench, settleWindows, windowPoint, benchBounds, viewedWindow, preserveViewedWindow, restoreBenchCamera, raiseWindow, activeSurface, dockGeometry, dockMinimum } = await import("../lib/stack/geometry.ts");
const { emptyLocation, navigateTo, parseLocation, locationHref } = await import("../lib/stack/navigation.ts");
const { inputTemplate, requestExample, subscriptionExample } = await import("../lib/stack/reference.ts");

const region = (id, width = 100, height = 80, x = 0, y = 0) => ({ id, bounds: { x, y, width, height } });
test("one, two, three and four regions form centered, side-by-side, triangular and square arrangements", () => {
  assert.deepEqual(packSpaces([region("a")]), { a: { x: -44, y: -44 } });
  const pair = packSpaces([region("a"), region("b")], 20);
  assert.equal(pair.a.y, pair.b.y);
  assert.equal(pair.b.x - pair.a.x, 110);
  const triangle = packSpaces([region("a"), region("b"), region("c")], 20);
  assert.ok(Math.abs(triangle.a.x + 50) <= gridSize / 2, "a lone region stays centered within a snap");
  assert.ok(triangle.a.y < triangle.b.y);
  assert.equal(triangle.b.y, triangle.c.y);
  assert.ok(Math.abs(triangle.b.x + triangle.c.x + 100) <= gridSize / 2, "a balanced row stays centered within a snap");
  const square = packSpaces([region("a"), region("b"), region("c"), region("d")], 20);
  assert.equal(square.a.y, square.b.y);
  assert.equal(square.c.y, square.d.y);
  assert.equal(square.a.x, square.c.x);
  assert.equal(square.b.x, square.d.x);
});

test("heterogeneous negative-origin footprints remain deterministic, centered and non-overlapping at scale", () => {
  for (const count of [1, 2, 3, 4, 5, 7, 11, 24]) {
    const spaces = Array.from({ length: count }, (_, i) => region(`s${i}`, 180 + i * 37, 120 + (i % 4) * 89, -i * 3, i * 7));
    const before = structuredClone(spaces);
    const packed = packSpaces(spaces);
    assert.deepEqual(packSpaces(spaces), packed);
    assert.deepEqual(spaces, before);
    const rectangles = spaces.map((s) => ({ ...s.bounds, x: packed[s.id].x + s.bounds.x, y: packed[s.id].y + s.bounds.y }));
    const bounds = boundsOf(rectangles);
    assert.ok(Math.abs(bounds.x + bounds.width / 2) <= gridSize / 2, `centered within a snap at ${count}`);
    assert.ok(Math.abs(bounds.y + bounds.height / 2) <= gridSize / 2, `centered within a snap at ${count}`);
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      const a = rectangles[i], b = rectangles[j];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${i} overlaps ${j}`);
    }
  }
  assert.deepEqual(packSpaces([]), {});
});

test("local structure uses stable explicit bounds, not record count or connection state", () => {
  const defs = [{ id: "a", column: 0, width: 300, height: 200 }, { id: "b", column: 0, width: 400, height: 100 }, { id: "c", column: 1, width: 180, height: 500 }];
  const a = localLayout(defs);
  assert.equal(a.positions.b.y, 220);
  assert.equal(a.positions.c.x, 466);
  assert.equal(a.bounds.width, 646);
  assert.equal(a.bounds.height, 500);
  assert.deepEqual(localLayout(defs.map((d) => ({ ...d, records: [1, 2, 3], connected: true }))), a);
});

test("repacking preserves a manual local point's screen coordinates", () => {
  const before = packSpaces([region("a"), region("b")]);
  const after = packSpaces([region("a"), region("b"), region("c", 340, 700)]);
  const camera = { x: 130, y: -50, k: 0.73 };
  const manual = { x: 87, y: -213 };
  const moved = preserveAnchor(camera, before.b, after.b);
  assert.equal(camera.x + (before.b.x + manual.x) * camera.k, moved.x + (after.b.x + manual.x) * moved.k);
  assert.ok(Math.abs(camera.y + (before.b.y + manual.y) * camera.k - moved.y - (after.b.y + manual.y) * moved.k) < 1e-9);
});

test("fit handles empty, tall and wide bounds without non-finite camera values", () => {
  for (const bounds of [{ x: 0, y: 0, width: 0, height: 0 }, { x: -400, y: -800, width: 800, height: 1600 }, { x: -4000, y: 20, width: 8000, height: 600 }]) {
    const camera = fitBounds(bounds, 1000, 800);
    assert.ok(Object.values(camera).every(Number.isFinite));
    assert.ok(camera.k >= 0.3 && camera.k <= 1);
  }
});

const windowDef = (id, width = 300, height = 200, column = 0) => ({ id, width, height, column });
const syntheticSpaces = [
  { id: "fleet", windows: [windowDef("accounts"), windowDef("bots", 400, 700, 1)] },
  { id: "future", windows: [windowDef("tasks", 500, 300)] },
  { id: "another", windows: [windowDef("projects", 200, 400)] },
];

test("restore and structural packing reserve the effective manual extents before adding neighbors", () => {
  const saved = {
    positions: { bots: { x: 2300, y: -800 }, accounts: { x: -900, y: 100 }, tasks: { x: NaN, y: 10 }, stale: { x: 50000, y: 0 } },
    manual: { bots: true, accounts: true, tasks: true, stale: true }, collapsed: { bots: true }, order: ["stale", "bots", "accounts", "bots"],
  };
  const fleetOnly = reconcileBench(syntheticSpaces.slice(0, 1), saved);
  const structural = reconcileBench(syntheticSpaces, fleetOnly.layout);
  const restored = reconcileBench(syntheticSpaces, saved);
  assert.deepEqual(structural, restored);
  assert.deepEqual(structural.geometry.regions[0].bounds, { x: -900, y: -800, width: 3596, height: 1098 });
  assert.deepEqual(structural.layout.positions.bots, saved.positions.bots);
  assert.deepEqual(structural.layout.positions.tasks, { x: 0, y: 0 });
  assert.equal(structural.layout.manual.tasks, undefined);
  assert.equal(structural.layout.positions.stale, undefined);
  assert.deepEqual(structural.layout.order, ["bots", "accounts", "tasks", "projects"]);
  // A collapsed window still reserves its declared structural height.
  assert.deepEqual(reconcileBench(syntheticSpaces, { ...saved, collapsed: {} }).geometry, restored.geometry);
  const footprints = structural.geometry.regions.map((region) => ({ ...region.bounds, x: structural.geometry.origins[region.id].x + region.bounds.x, y: structural.geometry.origins[region.id].y + region.bounds.y }));
  for (let i = 0; i < footprints.length; i++) for (let j = i + 1; j < footprints.length; j++) {
    const a = footprints[i], b = footprints[j];
    assert.ok(a.x + a.width + 240 - gridSize <= b.x || b.x + b.width + 240 - gridSize <= a.x || a.y + a.height + 240 - gridSize <= b.y || b.y + b.height + 240 - gridSize <= a.y, `manual footprint ${i} overlaps neighbor ${j}`);
  }
  // Pointer updates can retain frozen origins, then the next structural boundary uses their latest positions.
  const dragged = { ...fleetOnly, layout: { ...fleetOnly.layout, positions: { ...fleetOnly.layout.positions, bots: { x: 6000, y: -900 } } } };
  assert.equal(dragged.geometry, fleetOnly.geometry);
  assert.equal(reconcileBench(syntheticSpaces, dragged.layout).geometry.regions[0].bounds.width, 7296);
});

test("repacking and tidy preserve the viewed retained window, including a changed default local position", () => {
  const before = reconcileBench([{ id: "fleet", windows: [windowDef("accounts"), windowDef("bots", 400, 700)] }], { positions: { accounts: { x: -600, y: -300 } }, manual: { accounts: true } });
  const viewport = { width: 1000, height: 800 };
  const point = windowPoint(before, "bots");
  const camera = { k: 0.8, x: 500 - (point.x + 200) * 0.8, y: 400 - (point.y + 350) * 0.8 };
  assert.equal(viewedWindow(before, camera, viewport).id, "bots");
  const changed = [{ id: "fleet", windows: [windowDef("inserted", 200, 500), windowDef("accounts"), windowDef("bots", 400, 700)] }, syntheticSpaces[1]];
  const after = reconcileBench(changed, before.layout);
  const tidy = reconcileBench(changed, { ...after.layout, manual: {}, positions: {} });
  const screen = (view, position) => ({ x: view.x + position.x * view.k, y: view.y + position.y * view.k });
  const samePixel = (a, b) => assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
  const moved = preserveViewedWindow(camera, before, after, viewport);
  samePixel(screen(moved, windowPoint(after, "bots")), screen(camera, point));
  const tidied = preserveViewedWindow(moved, after, tidy, viewport);
  samePixel(screen(tidied, windowPoint(tidy, "bots")), screen(camera, point));
});

test("an incoming logical space overrides another space's persisted camera; matching saves reanchor", () => {
  const original = reconcileBench(syntheticSpaces.slice(0, 1));
  const packed = reconcileBench(syntheticSpaces);
  const viewport = { width: 1200, height: 900 };
  const saved = { space: "fleet", camera: { x: -700, y: 123, k: 0.9 }, anchor: { id: "bots", point: windowPoint(original, "bots") } };
  const incoming = restoreBenchCamera(saved, "future", packed, viewport);
  assert.deepEqual(incoming, fitBounds(benchBounds(packed, "future"), viewport.width, viewport.height, 0.65));
  const matching = restoreBenchCamera(saved, "fleet", packed, viewport);
  const nextPoint = windowPoint(packed, "bots");
  assert.equal(matching.x + nextPoint.x * matching.k, saved.camera.x + saved.anchor.point.x * saved.camera.k);
  assert.equal(matching.y + nextPoint.y * matching.k, saved.camera.y + saved.anchor.point.y * saved.camera.k);
  assert.equal(matching.k, saved.camera.k);
  for (const invalid of [{ ...saved, space: undefined }, { ...saved, camera: { x: NaN, y: 1, k: 1 } }, { ...saved, camera: { x: 1, y: 1, k: 0 } }]) {
    assert.deepEqual(restoreBenchCamera(invalid, "fleet", packed, viewport), fitBounds(benchBounds(packed, "fleet"), viewport.width, viewport.height, 0.65));
  }
});

test("right dock sizing reserves a usable bench after viewport shrink and expanded reading", () => {
  const options = { rightOpen: true, surface: "right", rightWidth: 1200 };
  const narrow = dockGeometry({ ...options, screenWidth: 900 });
  assert.equal(narrow.overlay, false);
  assert.equal(narrow.rightWidth, 660);
  assert.equal(narrow.rightMax, 660);
  for (const width of [900, 920, 1024, 1100, 1600]) for (const expanded of [true, false]) {
    const value = dockGeometry({ ...options, screenWidth: width, expanded });
    assert.equal(value.overlay, false);
    assert.ok(width - value.right >= dockMinimum.bench);
    assert.ok(value.rightWidth >= dockMinimum.right && value.rightWidth <= value.rightMax);
    if (expanded) assert.equal(value.rightWidth, value.rightMax);
  }
  assert.equal(dockGeometry({ ...options, screenWidth: 500 }).overlay, true);
  const closed = dockGeometry({ ...options, screenWidth: 900, rightOpen: false });
  assert.equal(closed.rightVisible, false);
  assert.equal(closed.right, 0);
  // Contraction hides the right dock on desktop but never overrides the overlay surface choice.
  const contracted = dockGeometry({ ...options, screenWidth: 1600, contracted: true });
  assert.equal(contracted.overlay, false);
  assert.equal(contracted.rightVisible, false);
  assert.equal(contracted.right, 0);
  assert.equal(contracted.rightWidth, 1200);
  assert.equal(dockGeometry({ ...options, screenWidth: 500, contracted: true, surface: "right" }).rightVisible, true);
  assert.equal(dockGeometry({ ...options, screenWidth: 500, contracted: true, surface: "bench" }).rightVisible, false);
});

test("mobile spatial navigation reveals the bench while retaining every dock destination", () => {
  const retained = { ...emptyLocation(), inspect: { kind: "bot", id: "bot-7" }, reference: { kind: "operation", pkg: "bots", id: "bot_status" } };
  const next = navigateTo(retained, { kind: "account", id: "a-1" });
  assert.deepEqual(next.inspect, retained.inspect);
  assert.deepEqual(next.reference, retained.reference);
  const options = { screenWidth: 390, rightOpen: true, rightWidth: 680 };
  const bench = dockGeometry({ ...options, surface: activeSurface("bench", options) });
  assert.equal(bench.rightVisible, false);
  assert.equal(bench.right, 0);
  assert.equal(dockGeometry({ ...options, surface: activeSurface("right", options) }).rightVisible, true);
  const url = new URL(locationHref(next), "http://localhost");
  url.searchParams.set("surface", "bench");
  assert.deepEqual(parseLocation(url.pathname, url.searchParams), next);
  assert.equal(activeSurface(url.searchParams.get("surface"), options), "bench");
  assert.equal(activeSurface(undefined, options), "right");
  assert.equal(activeSurface("right", { rightOpen: false }), "bench");
  assert.equal(activeSurface("left", options), "right");
});

test("focus and navigation use the same stable front ordering without adding removed windows", () => {
  const original = ["accounts", "bots", "tasks"];
  const focused = raiseWindow(original, "accounts");
  assert.deepEqual(focused, ["bots", "tasks", "accounts"]);
  const navigated = raiseWindow(focused, "bots");
  assert.deepEqual(navigated, ["tasks", "accounts", "bots"]);
  assert.equal(raiseWindow(navigated, "bots"), navigated);
  assert.equal(raiseWindow(navigated, "removed"), navigated);
  assert.deepEqual(original, ["accounts", "bots", "tasks"]);
});

test("dock and card destinations retain inspection; complete URLs restore the dock and target", () => {
  const selected = { kind: "account", id: "account: with spaces" };
  const base = { ...emptyLocation(), inspect: selected };
  const card = navigateTo(base, { kind: "bot", id: "bot-7" });
  const system = navigateTo(card, { kind: "child", id: "uix" });
  assert.equal(system.space, "system");
  assert.deepEqual(system.focus, { kind: "child", id: "uix" });
  const resource = navigateTo(system, { kind: "resource", id: "component:uix" });
  assert.equal(resource.space, "system");
  assert.deepEqual(resource.focus, { kind: "resource", id: "component:uix" });
  const process = navigateTo(system, { kind: "process", id: "process:9:ab" });
  assert.equal(process.space, "system");
  assert.deepEqual(process.focus, { kind: "process", id: "process:9:ab" });
  const reference = navigateTo(process, { kind: "operation", pkg: "bots", id: "bot_status" });
  assert.deepEqual(reference.inspect, selected);
  assert.deepEqual(reference.focus, process.focus);
  assert.equal(reference.space, "system");
  const url = new URL(locationHref(reference), "http://localhost");
  assert.deepEqual(parseLocation(url.pathname, url.searchParams), reference);
  // The retired `system` dock parameter is ignored; only real destinations resolve.
  assert.deepEqual(parseLocation("/x/fleet", new URLSearchParams("reference=overview&system=open")), { ...emptyLocation(), reference: "overview" });
  assert.deepEqual(parseLocation("/x/system", new URLSearchParams()), { ...emptyLocation("system") });
  assert.deepEqual(parseLocation("/x", new URLSearchParams("reference=bot:bad&inspect=package:bots&system=account:bad")), emptyLocation());
});

test("a card link crosses spaces: Bot to account lands in Accounts and back, keeping inspection", () => {
  const inspect = { kind: "bot", id: "bot-1" };
  const onAccount = navigateTo({ ...emptyLocation("fleet"), inspect }, { kind: "account", id: "a1" });
  assert.equal(onAccount.space, "accounts");
  assert.deepEqual(onAccount.focus, { kind: "account", id: "a1" });
  assert.deepEqual(onAccount.inspect, inspect);
  assert.equal(locationHref(onAccount), "/x/accounts?focus=account%3Aa1&inspect=bot%3Abot-1");
  const back = navigateTo(onAccount, inspect);
  assert.equal(back.space, "fleet");
  assert.deepEqual(parseLocation("/x/fleet", new URLSearchParams("focus=usage-account%3Abot%3Aa1")).space, "accounts");
});

test("transport templates never invent input values or unsupported call/subscription transports", () => {
  const operation = { name: "write", inputSchema: { type: "object", required: ["count", "id", "nested"], properties: { count: { type: "number" }, id: { type: "string", format: "uuid" }, nested: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }, optional: { type: "string" } } } };
  assert.deepEqual(inputTemplate(operation.inputSchema), { count: "<replace: number>", id: "<replace: string>", nested: { enabled: "<replace: boolean>" } });
  const socket = { type: "socket", supported: true, subscriptions: true };
  const ws = { ...socket, type: "websocket" };
  const mcp = { type: "mcp", supported: true, subscriptions: false };
  assert.equal(JSON.parse(requestExample(operation, socket, "bots")).jsonrpc, undefined);
  assert.equal(JSON.parse(requestExample(operation, ws, "bots")).method, "tools/call");
  assert.equal(JSON.parse(requestExample(operation, ws, "bots")).params.package, "bots");
  assert.equal(JSON.parse(requestExample(operation, mcp, "bots")).jsonrpc, "2.0");
  assert.equal(requestExample(operation, { ...socket, supported: false }, "bots"), null);
  assert.equal(requestExample(operation, { ...socket, type: "unknown" }, "bots"), null);
  const doc = { name: "bots", events: { changed: "Changed" }, eventScope: { required: true, example: "bot-1" } };
  assert.equal(subscriptionExample(doc, mcp), null);
  assert.equal(subscriptionExample(doc, { ...socket, subscriptions: false }), null);
  assert.equal(subscriptionExample({ ...doc, events: {} }, socket), null);
  const sub = JSON.parse(subscriptionExample(doc, ws));
  assert.equal(sub.method, "events/subscribe");
  assert.equal(sub.params.package, "bots");
  assert.equal(sub.params.subscription, "<replace: subscription id>");
  assert.equal(sub.params.scope, "<replace: subscription scope>");
  assert.deepEqual(sub.params.topics, ["changed"]);
});

test("human-set window sizes are clamped manual extents that packing reserves", () => {
  assert.equal(validSize(null), undefined);
  assert.equal(validSize({ width: "wide" }), undefined);
  assert.deepEqual(validSize({ width: 10, height: 99_999 }), { width: 280, height: 2000 });
  const spaces = [{ id: "fleet", windows: [{ id: "a", width: 300, column: 0 }, { id: "b", width: 300, column: 1 }] }];
  const packed = reconcileBench(spaces, { sizes: { a: { width: 600.4 }, gone: { width: 500 } } });
  assert.deepEqual(packed.layout.sizes, { a: { width: 600 } });
  assert.equal(packed.geometry.windows.find((def) => def.id === "a").width, 600);
  assert.equal(packed.layout.positions.b.x, 600 + 66, "tidy columns start after the resized width");
  assert.deepEqual(reconcileBench(spaces, { ...packed.layout, manual: {}, positions: {} }).layout.sizes, packed.layout.sizes, "tidy keeps sizes");
});

test("snapping lands world positions and far edges on the dot grid", () => {
  assert.equal(gridSize, 22);
  assert.equal(snap(32), 22);
  assert.equal(snap(34), 44);
  assert.equal(snap(-12), -22);
  const origin = -305.5;
  const local = snapLocal(417, origin);
  assert.equal((origin + local) % gridSize, 0);
  assert.equal(snapSize(301, 280, 960), 308);
  assert.equal(snapSize(270, 280, 960), 286, "the minimum rounds up to 13 cells");
  assert.equal(snapSize(990, 280, 960), 946, "the maximum rounds down to 43 cells");
  for (const extent of [308, 286, 946]) assert.equal(extent % gridSize, 0);
});

test("registered default extents snap to cells, so default windows land on the grid", () => {
  const spaces = [{ id: "fleet", windows: [
    { id: "a", width: 420, height: 620, column: 0 },
    { id: "b", width: 380, column: 0 },
    { id: "c", width: 420, height: 620, column: 1 },
  ] }];
  const packed = reconcileBench(spaces);
  const a = packed.geometry.windows.find((def) => def.id === "a");
  const b = packed.geometry.windows.find((def) => def.id === "b");
  assert.equal(a.width, 418);
  assert.equal(a.height, 616);
  assert.equal(b.width, 374);
  assert.equal(b.height, undefined);
  for (const def of packed.geometry.windows) {
    const point = windowPoint(packed, def.id);
    assert.ok(point.x % gridSize === 0, `${def.id} left is on the grid`);
    assert.ok(point.y % gridSize === 0, `${def.id} top is on the grid`);
  }
  // A window without a registered height reserves whole cells too, keeping a follower on the grid.
  const heightless = reconcileBench([{ id: "fleet", windows: [{ id: "top", width: 300, column: 0 }, { id: "below", width: 300, column: 0 }] }]);
  assert.ok(windowPoint(heightless, "below").y % gridSize === 0, "a window below a height-less window stays on the grid");
});

test("content growth pushes the windows below it out of the way and releases them when it shrinks", () => {
  const spaces = [{ id: "fleet", windows: [
    { id: "a", width: 300, height: 300, column: 0 }, { id: "b", width: 300, height: 200, column: 0 }, { id: "c", width: 300, height: 200, column: 0 },
    { id: "side", width: 300, height: 200, column: 1 },
  ] }];
  const packed = reconcileBench(spaces);
  const origin = packed.geometry.origins.fleet;
  const onGrid = (local) => (origin.y + local) % gridSize === 0;
  // Within its footprint, or unmeasured, nothing moves.
  assert.deepEqual(settleWindows(packed, {}), { a: 0, b: 0, c: 0, side: 0 });
  assert.deepEqual(settleWindows(packed, { a: 120, b: 198, c: 198, side: 900 }), { a: 0, b: 0, c: 0, side: 0 });
  // A grows past its footprint: B clears it on the grid and C cascades; the other column stays.
  const grown = settleWindows(packed, { a: 500, b: 200, c: 200, side: 200 });
  const b = packed.layout.positions.b.y + grown.b;
  assert.ok(b >= packed.layout.positions.a.y + 500 + gridSize && b < packed.layout.positions.a.y + 500 + gridSize + gridSize && onGrid(b));
  assert.ok(packed.layout.positions.c.y + grown.c >= b + 200 + gridSize);
  assert.equal(grown.a, 0);
  assert.equal(grown.side, 0);
  // A window that already overlapped in the stored layout is not below it, so it is not pushed.
  const overlapping = reconcileBench(spaces, { positions: { side: { x: 100, y: 100 } }, manual: { side: true } });
  assert.equal(settleWindows(overlapping, { a: 900, b: 200, c: 200, side: 200 }).side, 0);
  // Rendered bounds include the push and the grown height; footprint bounds do not.
  const rendered = benchBounds(packed, "fleet", { pushes: grown, heights: { a: 500 } });
  assert.ok(rendered.height > benchBounds(packed, "fleet").height);
});
