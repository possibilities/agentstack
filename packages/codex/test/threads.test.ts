import assert from "node:assert/strict";
import test from "node:test";
import { activeThreads, threadTree } from "../src/threads.js";

test("loaded threads nest subagents under the main thread", () => {
  const threads = activeThreads([
    { id: "gone", preview: "old", status: { type: "notLoaded" } },
    { id: "broken", preview: "err", status: { type: "systemError" } },
    {
      id: "main",
      preview: "plan the change",
      model: "gpt",
      parentThreadId: null,
      status: { type: "idle" },
    },
    {
      id: "child",
      preview: "",
      model: "gpt",
      parentThreadId: "main",
      status: { type: "active", activeFlags: [] },
    },
    {
      id: "ask",
      preview: "need input",
      parentThreadId: "missing-parent",
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    },
  ]);
  assert.deepEqual(threadTree(threads), [
    {
      id: "main",
      label: "plan the change",
      model: "gpt",
      activity: "idle",
      parentThreadId: null,
      children: [
        {
          id: "child",
          label: "child",
          model: "gpt",
          activity: "working",
          parentThreadId: "main",
          children: [],
        },
      ],
    },
    {
      id: "ask",
      label: "need input",
      model: null,
      activity: "waiting",
      parentThreadId: "missing-parent",
      children: [],
    },
  ]);
});
