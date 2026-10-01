import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { orientationChip, orientationLabel, orientationMeaning, orientationPhase, orientationRefusesInput, orientationSettled, orientationStatus, voiceBlockedByOrientation } = await import("../lib/stack/orientation.ts");
const owner = await import("../../bots/dist/src/orientation.js");

const at = (state) => ({ admissionId: "8f0f2a54-6a63-4f65-9b3c-0e5d0d0b7a10", state, threadId: null, turnId: null, issue: null, updatedAt: 1 });

test("every state the Bots owner can record is read the way the owner and the voice gate read it", () => {
  const states = owner.orientationState.shape.state.options;
  for (const state of states) {
    const value = at(state);
    assert.equal(orientationSettled(value), owner.orientationSettled(value), `${state} settles as the owner says`);
    assert.equal(voiceBlockedByOrientation(value), !owner.orientationSettled(value), `${state} holds voice until the outcome is known`);
    for (const read of [orientationLabel, orientationStatus, orientationMeaning]) assert.ok(read(value), `${state} is named by ${read.name}`);
  }
});

test("admission, a running introduction, an unknown outcome and each known outcome stay distinct", () => {
  const phases = { pending: "admitting", creating: "admitting", ready: "admitting", submitting: "admitting", running: "introducing", unknown: "unknown",
    completed: "completed", failed: "failed", interrupted: "interrupted", retired: "retired" };
  assert.deepEqual(Object.keys(phases).sort(), [...owner.orientationState.shape.state.options].sort(), "every owner state is placed in a phase");
  for (const [state, phase] of Object.entries(phases)) assert.equal(orientationPhase(at(state)), phase, state);
  // Each phase reads differently, so a failed or reset introduction is never mistaken for a completed one.
  const labels = new Set(["pending", "running", "unknown", "completed", "failed", "interrupted", "retired"].map((state) => orientationLabel(at(state))));
  assert.equal(labels.size, 7);
  // Only states that need attention get a Fleet chip, and only admission refuses competing chat input.
  for (const [state, phase] of Object.entries(phases)) {
    assert.equal(orientationChip(at(state)) !== null, ["admitting", "introducing", "unknown", "failed", "interrupted"].includes(phase), `${state} chip`);
    assert.equal(orientationRefusesInput(at(state)), phase === "admitting", `${state} refusal`);
  }
  // A legacy Bot was never enrolled: not pending, nothing to name, nothing holding voice.
  for (const legacy of [null, undefined]) {
    assert.equal(orientationPhase(legacy), "legacy");
    assert.equal(orientationLabel(legacy), null);
    assert.equal(orientationChip(legacy), null);
    assert.equal(orientationSettled(legacy), true);
    assert.equal(voiceBlockedByOrientation(legacy), false);
  }
});
