// Open bench geometry, navigation and transport-reference contracts.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { snap, snapLocal, snapExtent, gridSize, validSize, packSpaces, localLayout, boundsOf, preserveAnchor, compensateLeft, fitBounds, reconcileBench, windowPoint, benchBounds, viewedWindow, preserveViewedWindow, restoreBenchCamera, raiseWindow, activeSurface, dockGeometry, dockMinimum } = await import("../lib/stack/geometry.ts");
const { emptyLocation, navigateTo, parseLocation, locationHref } = await import("../lib/stack/navigation.ts");
const { inputTemplate, requestExample, subscriptionExample } = await import("../lib/stack/reference.ts");

const region = (id, width = 100, height = 80, x = 0, y = 0) => ({ id, bounds: { x, y, width, height } });
test("one, two, three and four regions form centered, side-by-side, triangular and square arrangements", () => {
  assert.deepEqual(packSpaces([region("a")]), { a: { x: -50, y: -40 } });
  const pair = packSpaces([region("a"), region("b")], 20);
  assert.equal(pair.a.y, pair.b.y);
  assert.equal(pair.b.x - pair.a.x, 120);
  const triangle = packSpaces([region("a"), region("b"), region("c")], 20);
  assert.equal(triangle.a.x + 50, 0);
  assert.ok(triangle.a.y < triangle.b.y);
  assert.equal(triangle.b.y, triangle.c.y);
  assert.equal(triangle.b.x + triangle.c.x + 100, 0);
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
    assert.equal(bounds.x + bounds.width / 2, 0);
    assert.equal(bounds.y + bounds.height / 2, 0);
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
  assert.equal(a.positions.b.y, 224);
  assert.equal(a.positions.c.x, 472);
  assert.equal(a.bounds.width, 652);
  assert.equal(a.bounds.height, 500);
  assert.deepEqual(localLayout(defs.map((d) => ({ ...d, records: [1, 2, 3], connected: true }))), a);
});

test("repacking and a left dock resize preserve a manual local point's screen coordinates", () => {
  const before = packSpaces([region("a"), region("b")]);
  const after = packSpaces([region("a"), region("b"), region("c", 340, 700)]);
  const camera = { x: 130, y: -50, k: 0.73 };
  const manual = { x: 87, y: -213 };
  const moved = preserveAnchor(camera, before.b, after.b);
  assert.equal(camera.x + (before.b.x + manual.x) * camera.k, moved.x + (after.b.x + manual.x) * moved.k);
  assert.ok(Math.abs(camera.y + (before.b.y + manual.y) * camera.k - moved.y - (after.b.y + manual.y) * moved.k) < 1e-9);
  const resized = compensateLeft(moved, 320, 460);
  assert.equal(moved.x + 320, resized.x + 460);
  assert.equal(moved.y, resized.y);
  assert.equal(moved.k, resized.k);
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
  assert.deepEqual(structural.geometry.regions[0].bounds, { x: -900, y: -800, width: 3600, height: 1100 });
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
    assert.ok(a.x + a.width + 240 <= b.x || b.x + b.width + 240 <= a.x || a.y + a.height + 240 <= b.y || b.y + b.height + 240 <= a.y, `manual footprint ${i} overlaps neighbor ${j}`);
  }
  // Pointer updates can retain frozen origins, then the next structural boundary uses their latest positions.
  const dragged = { ...fleetOnly, layout: { ...fleetOnly.layout, positions: { ...fleetOnly.layout.positions, bots: { x: 6000, y: -900 } } } };
  assert.equal(dragged.geometry, fleetOnly.geometry);
  assert.equal(reconcileBench(syntheticSpaces, dragged.layout).geometry.regions[0].bounds.width, 7300);
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
  const incoming = restoreBenchCamera(saved, "future", packed, viewport, 352);
  assert.deepEqual(incoming, fitBounds(benchBounds(packed, "future"), viewport.width, viewport.height, 0.65));
  const matching = restoreBenchCamera(saved, "fleet", packed, viewport, 352);
  const nextPoint = windowPoint(packed, "bots");
  assert.equal(matching.x + 352 + nextPoint.x * matching.k, saved.camera.x + saved.anchor.point.x * saved.camera.k);
  assert.equal(matching.y + nextPoint.y * matching.k, saved.camera.y + saved.anchor.point.y * saved.camera.k);
  assert.equal(matching.k, saved.camera.k);
  for (const invalid of [{ ...saved, space: undefined }, { ...saved, camera: { x: NaN, y: 1, k: 1 } }, { ...saved, camera: { x: 1, y: 1, k: 0 } }]) {
    assert.deepEqual(restoreBenchCamera(invalid, "fleet", packed, viewport, 0), fitBounds(benchBounds(packed, "fleet"), viewport.width, viewport.height, 0.65));
  }
});

test("joint dock sizing reserves a usable bench after viewport shrink and expanded reading", () => {
  const options = { systemOpen: true, rightOpen: true, surface: "right", systemWidth: 520, rightWidth: 1200 };
  const narrow = dockGeometry({ ...options, screenWidth: 900 });
  assert.equal(narrow.leftWidth, 340);
  assert.equal(narrow.leftMax, 340);
  assert.equal(narrow.rightWidth, 320);
  assert.equal(narrow.rightMax, 320);
  for (const width of [900, 920, 1024, 1100, 1600]) for (const expanded of [true, false]) {
    const value = dockGeometry({ ...options, screenWidth: width, expanded });
    assert.equal(value.overlay, false);
    assert.ok(width - value.left - value.right >= dockMinimum.bench);
    assert.ok(value.leftWidth >= dockMinimum.left && value.leftWidth <= value.leftMax);
    assert.ok(value.rightWidth >= dockMinimum.right && value.rightWidth <= value.rightMax);
    if (expanded) assert.equal(value.rightWidth, value.rightMax);
  }
  assert.equal(dockGeometry({ ...options, screenWidth: 800 }).overlay, true);
  const single = dockGeometry({ ...options, screenWidth: 900, rightOpen: false });
  assert.equal(single.leftWidth, 520);
  assert.equal(single.right, 0);
});

test("mobile spatial navigation reveals the bench while retaining every dock destination", () => {
  const retained = { ...emptyLocation(), inspect: { kind: "bot", id: "bot-7" }, reference: { kind: "operation", pkg: "bots", id: "bot_status" }, system: { kind: "child", id: "uix" } };
  const next = navigateTo(retained, { kind: "account", id: "a-1" });
  assert.deepEqual(next.inspect, retained.inspect);
  assert.deepEqual(next.reference, retained.reference);
  assert.deepEqual(next.system, retained.system);
  const options = { screenWidth: 390, systemOpen: true, rightOpen: true, systemWidth: 520, rightWidth: 680 };
  const bench = dockGeometry({ ...options, surface: activeSurface("bench", options) });
  assert.equal(bench.systemVisible, false);
  assert.equal(bench.rightVisible, false);
  assert.equal(bench.left + bench.right, 0);
  assert.equal(dockGeometry({ ...options, surface: activeSurface("right", options) }).rightVisible, true);
  assert.equal(dockGeometry({ ...options, surface: activeSurface("left", options) }).systemVisible, true);
  const url = new URL(locationHref(next), "http://localhost");
  url.searchParams.set("surface", "bench");
  assert.deepEqual(parseLocation(url.pathname, url.searchParams), next);
  assert.equal(activeSurface(url.searchParams.get("surface"), options), "bench");
  assert.equal(activeSurface(undefined, options), "right");
  assert.equal(activeSurface("right", { systemOpen: true, rightOpen: false }), "left");
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

test("dock and card destinations retain inspection; complete URLs restore both docks and target", () => {
  const selected = { kind: "account", id: "account: with spaces" };
  const base = { ...emptyLocation(), inspect: selected };
  const card = navigateTo(base, { kind: "bot", id: "bot-7" });
  const system = navigateTo(card, { kind: "child", id: "uix" });
  const reference = navigateTo(system, { kind: "operation", pkg: "bots", id: "bot_status" });
  assert.deepEqual(reference.inspect, selected);
  assert.deepEqual(reference.focus, card.focus);
  assert.equal(reference.space, "fleet");
  const url = new URL(locationHref(reference), "http://localhost");
  assert.deepEqual(parseLocation(url.pathname, url.searchParams), reference);
  assert.deepEqual(parseLocation("/x/fleet", new URLSearchParams("reference=overview&system=open")), { ...emptyLocation(), reference: "overview", system: "open" });
  assert.equal(parseLocation("/x/system", new URLSearchParams()), null);
  assert.deepEqual(parseLocation("/x", new URLSearchParams("reference=bot:bad&inspect=package:bots&system=account:bad")), emptyLocation());
});

test("transport templates never invent input values or unsupported call/subscription transports", () => {
  const operation = { name: "write", inputSchema: { type: "object", required: ["count", "id", "nested"], properties: { count: { type: "number" }, id: { type: "string", format: "uuid" }, nested: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }, optional: { type: "string" } } } };
  assert.deepEqual(inputTemplate(operation.inputSchema), { count: "<replace: number>", id: "<replace: string>", nested: { enabled: "<replace: boolean>" } });
  const socket = { type: "socket", supported: true, subscriptions: true };
  const ws = { ...socket, type: "websocket" };
  const mcp = { type: "mcp", supported: true, subscriptions: false };
  assert.equal(JSON.parse(requestExample(operation, socket)).jsonrpc, undefined);
  assert.equal(JSON.parse(requestExample(operation, ws)).method, "tools/call");
  assert.equal(JSON.parse(requestExample(operation, mcp)).jsonrpc, "2.0");
  assert.equal(requestExample(operation, { ...socket, supported: false }), null);
  assert.equal(requestExample(operation, { ...socket, type: "unknown" }), null);
  const doc = { events: { changed: "Changed" }, eventScope: { required: true, example: "bot-1" } };
  assert.equal(subscriptionExample(doc, mcp), null);
  assert.equal(subscriptionExample(doc, { ...socket, subscriptions: false }), null);
  assert.equal(subscriptionExample({ ...doc, events: {} }, socket), null);
  const sub = JSON.parse(subscriptionExample(doc, ws));
  assert.equal(sub.method, "events/subscribe");
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
  assert.equal(packed.layout.positions.b.x, 600 + 72, "tidy columns start after the resized width");
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
  assert.equal(snapExtent(110, 301), 308, "right edge at 418 = 19 × 22");
});
