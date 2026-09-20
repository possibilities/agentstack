import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ManagedChild,
  type ChildSpec,
  type ReadinessProbe,
} from "../../packages/runtime/src/index.js";

const fixture = resolve(import.meta.dirname, "../fixtures/fake-child.mjs");
const probe: ReadinessProbe = {
  timeoutMs: 500,
  request() {
    return {
      request: {
        jsonrpc: "2.0",
        id: "test-init",
        method: "initialize",
        params: {},
      },
    };
  },
  classify(message) {
    if (message.id !== "test-init") return null;
    if (message.result) return { readiness: "ready", failure: null };
    const error = message.error as { message?: string } | undefined;
    const auth = /auth/i.test(error?.message ?? "");
    return {
      readiness: auth ? "auth-required" : "incompatible",
      failure: {
        code: auth ? "auth_required" : "rejected",
        message: error?.message ?? "rejected",
      },
    };
  },
};

function spec(id: "codex" | "fx", mode = "ready"): ChildSpec {
  return {
    id,
    sourceVersion: "fixture",
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", FAKE_MODE: mode },
    probe,
  };
}

async function waitFor(
  assertion: () => boolean,
  timeout = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("condition timed out");
}

describe("direct child lifecycle", () => {
  test("starts, probes and stops an owned child", async () => {
    await access(fixture);
    const child = new ManagedChild(spec("codex"), () => undefined, {
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      maxFailures: 3,
      failureWindowMs: 1000,
      stableResetMs: 100,
      stopGraceMs: 100,
    });
    await child.start();
    await waitFor(() => child.status().readiness === "ready");
    const running = child.status();
    expect(running.observedState).toBe("running");
    expect(running.pid).toBeTypeOf("number");
    expect(running.generation).toBeTruthy();
    await child.stop();
    expect(child.status()).toMatchObject({
      observedState: "stopped",
      pid: null,
      desiredState: "stopped",
    });
  });

  test("restarts one child without changing its sibling generation", async () => {
    const codex = new ManagedChild(spec("codex"), () => undefined);
    const fx = new ManagedChild(spec("fx"), () => undefined);
    await Promise.all([codex.start(), fx.start()]);
    await waitFor(
      () =>
        codex.status().readiness === "ready" &&
        fx.status().readiness === "ready",
    );
    const oldCodex = codex.status().generation;
    const oldFx = fx.status().generation;
    await codex.restart();
    await waitFor(() => codex.status().readiness === "ready");
    expect(codex.status().generation).not.toBe(oldCodex);
    expect(fx.status().generation).toBe(oldFx);
    await Promise.all([codex.stop(), fx.stop()]);
  });

  test("bounds crash retries and remains observable", async () => {
    const child = new ManagedChild(spec("fx", "exit"), () => undefined, {
      initialBackoffMs: 5,
      maxBackoffMs: 10,
      maxFailures: 3,
      failureWindowMs: 1000,
      stableResetMs: 100,
      stopGraceMs: 50,
    });
    await child.start();
    await waitFor(() => child.status().observedState === "failed");
    expect(child.status()).toMatchObject({
      readiness: "unavailable",
      desiredState: "running",
      observedState: "failed",
    });
    await child.stop();
  });

  test("reports auth-required without a restart storm", async () => {
    const child = new ManagedChild(spec("fx", "auth"), () => undefined);
    await child.start();
    await waitFor(() => child.status().readiness === "auth-required");
    const generation = child.status().generation;
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(child.status().generation).toBe(generation);
    expect(child.status().restartCount).toBe(0);
    await child.stop();
  });
});
