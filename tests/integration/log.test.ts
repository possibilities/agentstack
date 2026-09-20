import { afterEach, describe, expect, test, vi } from "vitest";
import { log, sanitizeReason } from "../../packages/runtime/src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("bounded redacted logs", () => {
  test("removes token bodies and raw URLs from sanitized failures", () => {
    expect(sanitizeReason("credential sk-FAKESECRET12345")).toBe(
      "credential [redacted]",
    );
    expect(sanitizeReason("Bearer abc.DEF-123_secret")).toBe(
      "Bearer [redacted]",
    );
    expect(sanitizeReason("token=plain-secret-value")).toBe("token=[redacted]");
    expect(
      sanitizeReason(
        "request failed at https://example.invalid/path?token=secret-value",
      ),
    ).toBe("request failed at [url-redacted]");
  });

  test("redacts nested launch data before the sink", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    log({
      level: "error",
      component: "daemon",
      event: "adversarial",
      reason: "credential sk-FAKESECRET12345",
      rawUrl: "https://example.invalid/private?token=secret-value",
      launch: {
        env: {
          GITHUB_TOKEN: "ghp_FAKESECRET123456789",
          PASSWORD: "password=secret-value",
        },
      },
      daemonError: new Error(
        "startup failed at https://example.invalid/private?token=secret-value",
      ),
    });
    const line = writes.join("");
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain("FAKESECRET");
    expect(line).not.toContain("secret-value");
    expect(line).not.toContain("https://");
    expect(line).toContain("[redacted]");
    expect(line).toContain("[url-redacted]");
  });

  test("does not reconstruct a 6,139-byte secret event in fallback JSON", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const token = "sk-PRIVATE_SYNTHETIC_TOKEN_12345";
    const event = `${"x".repeat(6_139 - Buffer.byteLength(token))}${token}`;
    expect(Buffer.byteLength(event)).toBe(6_139);
    log({
      level: "warn",
      component: "control",
      event,
      details: Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => [
          `field${index}`,
          "x".repeat(2_000),
        ]),
      ),
    });
    const line = writes.join("");
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4097);
    expect(line).not.toContain("PRIVATE_SYNTHETIC_TOKEN");
    expect(line).not.toContain("sk-");
    expect(JSON.parse(line)).toMatchObject({
      level: "warn",
      component: "control",
      event: "log_record_truncated",
      reason: "log_record_truncated",
    });
  });
});
