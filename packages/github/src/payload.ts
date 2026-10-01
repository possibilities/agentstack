import type { Delivery } from "./schema.js";

export function decodePayload(raw: Uint8Array, contentType: Delivery["contentType"]): Record<string, unknown> {
  // Fatal UTF-8 decoding avoids silently changing signed bytes before interpretation.
  let text = new TextDecoder("utf8", { fatal: true }).decode(raw);
  if (contentType === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(text);
    if (form.getAll("payload").length !== 1 || [...form.keys()].some(key => key !== "payload")) throw new Error("github_payload_invalid");
    text = form.get("payload")!;
  }
  const payload: unknown = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("github_payload_invalid");
  return payload as Record<string, unknown>;
}
