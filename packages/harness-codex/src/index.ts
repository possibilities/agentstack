import type { ProbeResult, ReadinessProbe } from "@agentstack/runtime";

function errorMessage(message: Record<string, unknown>): string {
  const error = message.error;
  if (typeof error !== "object" || error === null) return "initialize failed";
  const value = (error as Record<string, unknown>).message;
  return typeof value === "string" ? value : "initialize failed";
}

export function createCodexProbe(productVersion: string): ReadinessProbe {
  return {
    timeoutMs: 8_000,
    request() {
      return {
        request: {
          id: "agentstack-codex-initialize",
          method: "initialize",
          params: {
            clientInfo: {
              name: "agentstack",
              title: "AgentStack",
              version: productVersion,
            },
            capabilities: { experimentalApi: false },
          },
        },
        initializedNotification: { method: "initialized", params: {} },
      };
    },
    classify(message): ProbeResult | null {
      if (message.id !== "agentstack-codex-initialize") return null;
      if (message.result && typeof message.result === "object")
        return { readiness: "ready", failure: null };
      const detail = errorMessage(message);
      const auth = /auth|login|credential/i.test(detail);
      return {
        readiness: auth ? "auth-required" : "incompatible",
        failure: {
          code: auth ? "auth_required" : "initialize_rejected",
          message: detail,
        },
      };
    },
  };
}
