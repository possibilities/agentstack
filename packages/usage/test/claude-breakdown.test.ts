import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeUsage } from "../src/collect.js";

const usage = {
  five_hour: { utilization: 23, resets_at: "2026-09-26T08:20:00.181Z" },
  seven_day: { utilization: 3, resets_at: "2026-09-29T00:00:00.181Z" },
  seven_day_sonnet: null,
  seven_day_breakdown: {},
};

test("Claude usage ignores weekly breakdown metadata while preserving binding windows", () => {
  const parsed = parseClaudeUsage(usage);
  assert.deepEqual(parsed.windows.map((window) => window.id), ["five_hour", "seven_day"]);
  assert.equal(parsed.windows[0]?.usedPercent, 23);
  assert.equal(parsed.windows[1]?.usedPercent, 3);
  assert.equal(parsed.extraUsage, null);
});

test("Claude usage still rejects malformed scoped quota windows alongside breakdown metadata", () => {
  assert.throws(
    () => parseClaudeUsage({ ...usage, seven_day_new_model: {} }),
    /response_invalid/,
  );
});
