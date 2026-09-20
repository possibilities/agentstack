import type { ProbeResult, ReadinessProbe } from "@agentstack/runtime";

function errorMessage(message: Record<string, unknown>): string {
  const error = message.error;
  if (typeof error !== "object" || error === null) return "initialize failed";
  const value = (error as Record<string, unknown>).message;
  return typeof value === "string" ? value : "initialize failed";
}

export const fxProbe: ReadinessProbe = {
  timeoutMs: 8_000,
  request() {
    return {
      request: {
        jsonrpc: "2.0",
        id: "agentstack-fx-initialize",
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      },
    };
  },
  classify(message): ProbeResult | null {
    if (message.id !== "agentstack-fx-initialize") return null;
    if (message.result && typeof message.result === "object")
      return { readiness: "ready", failure: null };
    const detail = errorMessage(message);
    const auth = /auth|login|credential|api key|token/i.test(detail);
    return {
      readiness: auth ? "auth-required" : "incompatible",
      failure: {
        code: auth ? "auth_required" : "initialize_rejected",
        message: detail,
      },
    };
  },
};
