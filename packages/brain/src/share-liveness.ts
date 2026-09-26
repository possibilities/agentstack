import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { brainEnvironment, brainStateRoot } from "./paths.js";
import { dirname, join } from "node:path";
import type { DoctorCheck } from "./jobs.js";
import { defaultShareTokenPath, resolveShareServerToken } from "./share.js";

/**
 * Ingress liveness.
 *
 * A share ingress binds one address for the life of the process. When that
 * address goes away underneath it — the tailnet interface is torn down and
 * re-created, as a Tailscale restart does — the listening socket survives the
 * flap in name only: the process stays up, launchd's KeepAlive never fires,
 * and every connection is accepted and dropped without reaching the handler.
 * Nothing in the ledger records it, because no Admission is ever attempted;
 * the shares pile up in the Chrome and Android outboxes instead.
 *
 * So the ingress proves it can still serve by asking itself, and a process
 * that cannot answer its own health request exits rather than lingering.
 * Exiting is the correct move for a supervised service: the plist owns
 * restart, and a fresh bind is the only thing that recovers a stale one.
 * Re-binding in place was rejected — it races the old socket and hides the
 * flap from the operator (ADR 0021).
 */

export const INGRESS_REGISTRATION_VERSION = 1;

/** How long a serving ingress waits between proofs that it can still serve. */
export const DEFAULT_LIVENESS_INTERVAL_MS = 60_000;

/** One flap should not restart a healthy ingress; a sustained one must. */
export const DEFAULT_LIVENESS_FAILURE_THRESHOLD = 2;

const PROBE_TIMEOUT_MS = 5_000;

/**
 * What a serving ingress publishes about itself, so a later `doctor` in a
 * different process knows an ingress is supposed to be answering and where.
 * Written after the socket is bound, removed on clean shutdown.
 */
export interface IngressRegistration {
  version: number;
  url: string;
  host: string;
  port: number;
  pid: number;
  started_at: string;
}

export function defaultIngressRegistrationPath(home?: string): string {
  return join(brainStateRoot(brainEnvironment(), home), "share-ingress.json");
}

/** Brackets an IPv6 literal so the result is a usable HTTP authority. */
export function shareUrlFor(host: string, port: number): string {
  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

export function writeIngressRegistration(
  path: string,
  registration: IngressRegistration,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(registration, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

/** Returns null when no ingress is registered, or the file is unreadable. */
export function readIngressRegistration(
  path: string,
): IngressRegistration | null {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as Partial<IngressRegistration>;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.host !== "string"
    ) {
      return null;
    }
    return {
      version: parsed.version ?? INGRESS_REGISTRATION_VERSION,
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      pid: parsed.pid,
      started_at: parsed.started_at ?? "",
    };
  } catch {
    return null;
  }
}

export function clearIngressRegistration(path: string): void {
  rmSync(path, { force: true });
}

export interface IngressProbe {
  ok: boolean;
  /** Safe outcome label; never carries the token or a shared payload. */
  code: string;
  detail: string;
}

/**
 * Asks an ingress for `/v1/health` over its own bound address. This is the
 * whole point of the check: a socket that no longer serves still accepts, so
 * only a completed request proves the ingress is alive.
 */
export async function probeShareIngress(
  url: string,
  token: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<IngressProbe> {
  let response: Response;
  try {
    response = await fetch(`${url}/v1/health`, {
      method: "GET",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      // A redirect is not health, and following one would take the probe off
      // the address it is meant to be proving.
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return {
      ok: false,
      code: "unreachable",
      detail: `${url} did not answer (${(error as Error).name})`,
    };
  }
  if (response.status !== 200) {
    return {
      ok: false,
      code: `http_${response.status}`,
      detail: `${url} answered ${response.status}`,
    };
  }
  try {
    const body = (await response.json()) as { ok?: boolean };
    if (body.ok !== true) {
      return {
        ok: false,
        code: "unhealthy_body",
        detail: `${url} answered 200 without a healthy body`,
      };
    }
  } catch {
    return {
      ok: false,
      code: "bad_body",
      detail: `${url} answered 200 with an unreadable body`,
    };
  }
  return { ok: true, code: "healthy", detail: `${url} answered` };
}

export interface LivenessOptions {
  probe: () => Promise<IngressProbe>;
  intervalMs?: number;
  failureThreshold?: number;
  /** Reports every failed proof, including the ones still under threshold. */
  onFailure?: (probe: IngressProbe, consecutive: number) => void;
  /** Reports a recovery, so a transient flap is legible in the log. */
  onRecovery?: (consecutive: number) => void;
  /** Invoked once when the threshold is crossed; the caller owns exiting. */
  onFatal: (probe: IngressProbe, consecutive: number) => void;
}

export interface IngressLiveness {
  stop: () => void;
  /** Runs one round now. Exposed so tests need no timers. */
  check: () => Promise<void>;
}

/**
 * Starts the loop. Rounds never overlap: a probe that is slower than the
 * interval would otherwise pile up and count its own backlog as failures.
 */
export function startIngressLiveness(
  options: LivenessOptions,
): IngressLiveness {
  const intervalMs = options.intervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
  const threshold =
    options.failureThreshold ?? DEFAULT_LIVENESS_FAILURE_THRESHOLD;
  let consecutive = 0;
  let fired = false;
  let inFlight = false;

  const check = async (): Promise<void> => {
    if (inFlight || fired) return;
    inFlight = true;
    try {
      const probe = await options.probe();
      if (probe.ok) {
        if (consecutive > 0) options.onRecovery?.(consecutive);
        consecutive = 0;
        return;
      }
      consecutive += 1;
      options.onFailure?.(probe, consecutive);
      if (consecutive >= threshold) {
        fired = true;
        options.onFatal(probe, consecutive);
      }
    } finally {
      inFlight = false;
    }
  };

  const timer =
    intervalMs > 0 ? setInterval(() => void check(), intervalMs) : null;
  return {
    check,
    stop: () => {
      if (timer !== null) clearInterval(timer);
    },
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ShareIngressCheckOptions {
  registrationPath?: string;
  tokenPath?: string;
  probe?: (url: string, token: string) => Promise<IngressProbe>;
}

/**
 * The `doctor` view of the same question. The share service is opt-in, so an
 * unregistered ingress is not a defect; a registered one that cannot answer
 * is, because shares are being dropped while nothing in the ledger says so.
 */
export async function shareIngressCheck(
  options: ShareIngressCheckOptions = {},
): Promise<DoctorCheck> {
  const registrationPath =
    options.registrationPath ?? defaultIngressRegistrationPath();
  const registration = readIngressRegistration(registrationPath);
  if (registration === null) {
    return {
      name: "share_ingress",
      status: "ok",
      detail: "No share ingress registered",
    };
  }
  if (!processAlive(registration.pid)) {
    return {
      name: "share_ingress",
      status: "warning",
      detail: `Share ingress registered at ${registration.url} is not running (pid ${registration.pid}); inspect the owner-managed Brain child`,
    };
  }
  let token: string;
  try {
    token = resolveShareServerToken(
      options.tokenPath ?? defaultShareTokenPath(),
    ).token;
  } catch (error) {
    return {
      name: "share_ingress",
      status: "failed",
      detail: `Share ingress token unreadable: ${(error as Error).message}`,
    };
  }
  const probe = await (options.probe ?? probeShareIngress)(
    registration.url,
    token,
  );
  return {
    name: "share_ingress",
    status: probe.ok ? "ok" : "failed",
    detail: probe.ok
      ? `Share ingress healthy at ${registration.url}`
      : `Share ingress is listening but not serving: ${probe.detail}; inspect the owner-managed Brain child`,
  };
}
