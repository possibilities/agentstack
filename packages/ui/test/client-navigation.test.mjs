import assert from "node:assert/strict";
import test from "node:test";
import { browserNavigation } from "../bin/navigation.mjs";

// Negative navigation cases throw before any OS opener can run. Protects the
// future desk boundary's exact-origin pin, not a particular browser implementation.
test("client navigation refuses retargeting, missing platform pins and credential-bearing or non-web URLs", () => {
  const navigation = browserNavigation("http://127.0.0.1:19000");
  for (const url of ["http://localhost:19000/client", "https://evil.example/client", "javascript:alert(1)", "http://user:password@127.0.0.1:19000/client"])
    assert.throws(() => navigation.openClientSurface(url), /navigation_destination_refused/);
  for (const input of [
    { url: "https://platform.example:8945/connect/device", expectedOrigin: "https://platform.example:8943" },
    { url: "https://platform.example:8945/connect/device" },
    { url: "https://user:password@platform.example:8945/connect/device", expectedOrigin: "https://platform.example:8945" },
    { url: "file:///private/state", expectedOrigin: "null" },
  ]) assert.throws(() => navigation.openPlatform(input), /navigation_destination_refused/);
  for (const url of ["javascript:alert(1)", "file:///private/state", "https://user:password@external.example"])
    assert.throws(() => navigation.openExternal(url), /navigation_destination_refused/);
});
