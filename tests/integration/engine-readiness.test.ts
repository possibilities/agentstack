import { describe, expect, test } from "vitest";
import { createCodexReadinessProbe } from "../../packages/engine-codex/src/index.js";
import { fxReadinessProbe } from "../../packages/engine-fx/src/index.js";

describe("direct engine readiness protocols", () => {
  test("Codex emits only initialize metadata and classifies its reply", () => {
    const probe = createCodexReadinessProbe("0.1.1");
    expect(probe.request("unused")).toEqual({
      request: {
        id: "agentstack-codex-initialize",
        method: "initialize",
        params: {
          clientInfo: {
            name: "agentstack",
            title: "AgentStack",
            version: "0.1.1",
          },
          capabilities: { experimentalApi: false },
        },
      },
      initializedNotification: { method: "initialized", params: {} },
    });
    expect(
      probe.classify({
        id: "agentstack-codex-initialize",
        result: { capabilities: {} },
      }),
    ).toEqual({ readiness: "ready", failure: null });
    expect(
      probe.classify({
        id: "agentstack-codex-initialize",
        error: { message: "login required" },
      }),
    ).toMatchObject({ readiness: "auth-required" });
  });

  test("Fx emits only ACP initialize and rejects incompatible replies", () => {
    expect(fxReadinessProbe.request("unused")).toEqual({
      request: {
        jsonrpc: "2.0",
        id: "agentstack-fx-initialize",
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      },
    });
    expect(
      fxReadinessProbe.classify({
        id: "agentstack-fx-initialize",
        result: { protocolVersion: 1 },
      }),
    ).toEqual({ readiness: "ready", failure: null });
    expect(
      fxReadinessProbe.classify({
        id: "agentstack-fx-initialize",
        error: { message: "method unsupported" },
      }),
    ).toMatchObject({ readiness: "incompatible" });
  });
});
