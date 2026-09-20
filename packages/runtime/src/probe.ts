import type { Readable, Writable } from "node:stream";
import type { Readiness } from "@agentstack/contracts";
import { sanitizeReason } from "./log.js";

export interface ProbeRequest {
  request: Record<string, unknown>;
  initializedNotification?: Record<string, unknown>;
}

export interface ProbeResult {
  readiness: Readiness;
  failure: { code: string; message: string } | null;
}

export interface ReadinessProbe {
  readonly timeoutMs: number;
  request(generation: string): ProbeRequest;
  classify(message: Record<string, unknown>): ProbeResult | null;
}

export async function runJsonLineProbe(
  stdout: Readable,
  stdin: Writable,
  probe: ReadinessProbe,
  generation: string,
): Promise<ProbeResult> {
  const { request, initializedNotification } = probe.request(generation);
  return await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let buffered = "";
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onData);
      stdout.off("error", onError);
      stdout.off("end", onEnd);
      resolve(result);
    };
    const onError = (error: Error): void => {
      finish({
        readiness: "unavailable",
        failure: { code: "probe_io", message: sanitizeReason(error) },
      });
    };
    const onEnd = (): void => {
      finish({
        readiness: "unavailable",
        failure: {
          code: "probe_closed",
          message: "engine closed stdout before initialize",
        },
      });
    };
    const onData = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      if (buffered.length > 1024 * 1024) {
        finish({
          readiness: "incompatible",
          failure: {
            code: "frame_too_large",
            message: "engine response exceeded 1 MiB",
          },
        });
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          )
            continue;
          message = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const result = probe.classify(message);
        if (result) {
          if (result.readiness === "ready" && initializedNotification) {
            stdin.write(`${JSON.stringify(initializedNotification)}\n`);
          }
          finish(result);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      finish({
        readiness: "unavailable",
        failure: {
          code: "readiness_timeout",
          message: "engine did not answer initialize",
        },
      });
    }, probe.timeoutMs);
    timer.unref();
    stdout.on("data", onData);
    stdout.on("error", onError);
    stdout.on("end", onEnd);
    stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (error) onError(error);
    });
  });
}
