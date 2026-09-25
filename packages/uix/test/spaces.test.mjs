import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

// Load the pure stack modules directly without a Next build. Their
// bundler-style imports need extensions when loaded by Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { homeOf, spaceHref, parseSpacePath, parseNodeKey } = await import("../lib/stack/spaces.ts");
const { nodeKey } = await import("../lib/stack/types.ts");

test("homeOf maps every node kind to its space and window", () => {
  assert.deepEqual(homeOf({ kind: "owner" }), { space: "system", window: "system" });
  assert.deepEqual(homeOf({ kind: "child", id: "uix" }), { space: "system", window: "system" });
  assert.deepEqual(homeOf({ kind: "account", id: "acc-1" }), { space: "fleet", window: "accounts" });
  assert.deepEqual(homeOf({ kind: "login" }), { space: "fleet", window: "accounts" });
  assert.deepEqual(homeOf({ kind: "bot", id: "bot-1" }), { space: "fleet", window: "bots" });
  assert.deepEqual(homeOf({ kind: "package", id: "bots" }), { space: "api", window: "package:bots" });
  assert.deepEqual(homeOf({ kind: "operation", id: "bot_start", pkg: "bots" }), { space: "api", window: "package:bots" });
});

test("spaceHref builds space links with an optional encoded focus", () => {
  assert.equal(spaceHref("system"), "/x/system");
  assert.equal(spaceHref("api", { kind: "operation", id: "bot_start", pkg: "bots" }), "/x/api?focus=operation%3Abots.bot_start");
  assert.equal(spaceHref("fleet", { kind: "bot", id: "bot-1" }), "/x/fleet?focus=bot%3Abot-1");
});

test("parseSpacePath resolves /x and single space segments only", () => {
  assert.equal(parseSpacePath("/x"), "fleet");
  assert.equal(parseSpacePath("/x/"), "fleet");
  assert.equal(parseSpacePath("/x/api"), "api");
  assert.equal(parseSpacePath("/x/api/"), "api");
  assert.equal(parseSpacePath("/x/system"), "system");
  assert.equal(parseSpacePath("/x/fleet"), "fleet");
  assert.equal(parseSpacePath("/x/nope"), null);
  assert.equal(parseSpacePath("/x/api/extra"), null);
  assert.equal(parseSpacePath("/y"), null);
  assert.equal(parseSpacePath("/"), null);
});

test("parseNodeKey inverts nodeKey for every kind and rejects malformed keys", () => {
  const refs = [
    { kind: "owner" },
    { kind: "child", id: "uix" },
    { kind: "account", id: "acc-1" },
    { kind: "login" },
    { kind: "bot", id: "bot-1" },
    { kind: "package", id: "bots" },
    { kind: "operation", id: "bot_start", pkg: "bots" },
  ];
  for (const ref of refs) assert.deepEqual(parseNodeKey(nodeKey(ref)), ref);
  for (const bad of ["", "bogus", "account:", "operation:bots"]) assert.equal(parseNodeKey(bad), null);
});
