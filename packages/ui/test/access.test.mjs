import assert from "node:assert/strict";
import test from "node:test";

const access = await import("../lib/stack/access.ts");

const all = ["brain:share", "content:read", "access:enroll"];

test("expired history never selects active/revoked-unexpired entries or absent opaque IDs", () => {
  const data = { uiSessions: [{ id: "expired", credential_id: "cred", expires: 10 }, { id: "active", credential_id: "cred", expires: 11 }, { expires: 1 }],
    pairings: [{ id: "pair", label: "Old pairing", expires: 10 }, { id: "", label: "No ID", expires: 1 }],
    invitations: [{ id: "revoked", kind: "chrome", revoked: 1, expires: 11 }, { id: "invite", kind: "android", expires: 10 }] };
  for (const [kind, ids] of [["ui_sessions", ["expired"]], ["expired_pairings", ["pair"]], ["expired_invitations", ["invite"]]])
    assert.deepEqual(access.expiredAccessHistory(data, kind, 10).map((row) => row.id), ids);
});

test("enrollment is offered only to sponsor-eligible kinds, and a stored ineligible scope stays removable", () => {
  for (const kind of ["android", "chrome", "desktop"]) assert.deepEqual(access.grantScopeOptions(kind, all, []), all);
  for (const kind of ["browser", "tablet", undefined]) {
    assert.deepEqual(access.grantScopeOptions(kind, all, ["brain:share"]), ["brain:share", "content:read"]);
    // An existing browser record keeps its stored scope visible so it can be removed; it is never re-offered.
    assert.deepEqual(access.grantScopeOptions(kind, all, ["access:enroll"]), all);
    assert.equal(access.scopeAvailable(kind, "access:enroll"), false);
  }
});
