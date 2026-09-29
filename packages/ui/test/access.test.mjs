import assert from "node:assert/strict";
import test from "node:test";

const access = await import("../lib/stack/access.ts");

const all = ["brain:share", "content:read", "access:enroll"];

test("enrollment is offered only to sponsor-eligible kinds, and a stored ineligible scope stays removable", () => {
  for (const kind of ["android", "chrome", "desktop"]) assert.deepEqual(access.grantScopeOptions(kind, all, []), all);
  for (const kind of ["browser", "tablet", undefined]) {
    assert.deepEqual(access.grantScopeOptions(kind, all, ["brain:share"]), ["brain:share", "content:read"]);
    // An existing browser record keeps its stored scope visible so it can be removed; it is never re-offered.
    assert.deepEqual(access.grantScopeOptions(kind, all, ["access:enroll"]), all);
    assert.equal(access.scopeAvailable(kind, "access:enroll"), false);
  }
});
