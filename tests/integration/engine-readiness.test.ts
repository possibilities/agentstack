import { describe, expect, test } from "vitest";
import { createCodexReadinessProbe } from "../../packages/engine-codex/src/index.js";

describe("direct engine readiness protocols", () => {
  test("Codex emits only initialize metadata and classifies its reply", () => {
    const probe = createCodexReadinessProbe("0.1.2");
    expect(probe.request("unused")).toEqual({
      request: {
        id: "agentstack-codex-initialize",
        method: "initialize",
        params: {
          clientInfo: {
            name: "agentstack",
            title: "AgentStack",
            version: "0.1.2",
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


});
