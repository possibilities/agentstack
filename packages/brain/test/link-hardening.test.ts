import { test } from "node:test";
import { expect } from "expect";
import { planQueuedUrlFanout } from "../src/link-ingest.js";
import { sanitizeExternalError } from "../src/sanitize.js";

test("queued child identity uses the requested canonical provider identity", () => {
  const plan = planQueuedUrlFanout("https://x.com/root/status/1", [
    {
      relation_type: "references",
      target_url: "https://twitter.com/child/status/2?ref=timeline",
    },
  ]);
  expect(plan.discoveries[0]).toMatchObject({
    canonicalUrl: "https://x.com/i/status/2",
    resourceKey: { type: "x:status", value: "2" },
    relationType: "content_link",
    suppressionReason: null,
  });
});

test("external error sanitizer redacts secrets before truncating hostile tails", () => {
  const sanitized = sanitizeExternalError(
    `Authorization: Bearer top.secret token=abc123 password=hunter2 ${"x".repeat(1000)} tail_secret=never`,
  );
  expect(sanitized).not.toContain("top.secret");
  expect(sanitized).not.toContain("abc123");
  expect(sanitized).not.toContain("hunter2");
  expect(sanitized).not.toContain("never");
  expect(sanitized.length).toBeLessThanOrEqual(601);
});

test("external error sanitizer removes unsafe URLs, paths, and control characters", () => {
  const sanitized = sanitizeExternalError(
    "GET https://user:pass@example.com/private?token=query-secret&ok=1\n" +
      "/Users/mike/secrets/profile.json\u0000 Cookie: sessionid=private",
  );
  expect(sanitized).toContain(
    "https://[REDACTED]@example.com/private?token=[REDACTED]&ok=1",
  );
  expect(sanitized).toContain("[PRIVATE_PATH]");
  expect(sanitized).toContain("Cookie: [REDACTED]");
  expect(sanitized).not.toContain("user:pass");
  expect(sanitized).not.toContain("query-secret");
  expect(sanitized).not.toContain("/Users/mike");
  expect(sanitized).not.toContain("\u0000");
});
