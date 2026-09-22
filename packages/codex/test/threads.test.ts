import assert from "node:assert/strict";
import test from "node:test";
import { activeThreads } from "../src/threads.js";

test("only active threads are shown", () => {
  const threads = activeThreads([
    { id: "idle", preview: "done", status: { type: "idle" } },
    { id: "missing", preview: "gone", status: { type: "notLoaded" } },
    { id: "broken", preview: "err", status: { type: "systemError" } },
    { id: "live", preview: "working now", model: "gpt", status: { type: "active", activeFlags: [] } },
    {
      id: "ask",
      preview: "",
      model: null,
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    },
  ]);
  assert.deepEqual(threads, [
    { id: "live", label: "working now", model: "gpt", activity: "working" },
    { id: "ask", label: "ask", model: null, activity: "waiting" },
  ]);
});
