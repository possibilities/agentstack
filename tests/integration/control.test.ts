import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CONTROL_SCHEMA,
  SYSTEM_INVENTORY_SCHEMA,
  assertValidProcessComponents,
  statusExitCode,
  type ProcessComponent,
  type StatusResponse,
} from "../../packages/contracts/src/index.js";
import {
  closeControlServer,
  controlRequest,
  routeControlRequest,
  startControlServer,
} from "../../packages/runtime/src/index.js";

const servers: Array<{
  server: Awaited<ReturnType<typeof startControlServer>>;
  path: string;
}> = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(({ server, path }) => closeControlServer(server, path)),
  );
  vi.restoreAllMocks();
});

function status(): StatusResponse {
  const child = (id: "codex") => ({
    id,
    sourceVersion: "fixture",
    generation: id,
    pid: 1,
    desiredState: "running" as const,
    observedState: "running" as const,
    readiness: "ready" as const,
    startedAt: new Date(0).toISOString(),
    uptimeMs: 1,
    restartCount: 0,
    backoffUntil: null,
    lastFailure: null,
  });
  const components: ProcessComponent[] = ["daemon", "codex"].map(
    (id) => ({
      id,
      name: id,
      kind: id === "daemon" ? "daemon" : "engine",
      owner: id === "daemon" ? "systemd-user" : "agentstack-daemon",
      desiredState: "running",
      observedState: "running",
      pid: process.pid,
      version: "fixture",
      build: "fixture",
      source: "fixture",
      startedAt: new Date(0).toISOString(),
      uptimeMs: 1,
      readiness: "ready",
      generation: id,
      restartCount: 0,
      lastFailure: null,
      inventory: {
        summary: "fixture component",
        capabilities: [],
        preferences: [],
      },
    }),
  );
  assertValidProcessComponents(components);
  return {
    schema: CONTROL_SCHEMA,
    productVersion: "0.1.0",
    installedVersion: "0.1.0",
    runningVersion: "0.1.0",
    buildIdentity: "test",
    installPath: "/test",
    daemon: {
      generation: "daemon",
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      desiredState: "running",
    },
    systemInventory: { schema: SYSTEM_INVENTORY_SCHEMA, components },
    children: { codex: child("codex") },
  };
}

describe("private control socket", () => {
  test("routes bounded operations independently of the Unix transport", async () => {
    const response = await routeControlRequest("GET", "/v1/status", {
      status,
      async restart() {},
    });
    expect(response).toMatchObject({
      status: 200,
      body: { schema: CONTROL_SCHEMA },
    });
  });

  test("admits restart immediately and leaves terminal state to status", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const startedAt = Date.now();
    const response = await routeControlRequest(
      "POST",
      "/v1/children/codex/restart",
      {
        status,
        async restart() {
          await neverSettles;
        },
      },
    );
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(response).toMatchObject({
      status: 202,
      body: {
        accepted: true,
        outcome: "admitted",
        child: "codex",
        next: "/v1/status",
      },
    });
  });

  test("serves bounded status and restart operations at mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentstack-control-"));
    const path = join(root, "control.sock");
    const restarted: string[] = [];
    const server = await startControlServer(path, {
      status,
      async restart(id) {
        restarted.push(id);
      },
    });
    servers.push({ server, path });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await controlRequest<StatusResponse>(path, "GET", "/v1/status")).schema,
    ).toBe(CONTROL_SCHEMA);
    await controlRequest(path, "POST", "/v1/children/codex/restart");
    await new Promise((resolveWait) => setImmediate(resolveWait));
    expect(restarted).toEqual(["codex"]);
  });

  test("aborts an incomplete HTTP client within the shutdown deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentstack-control-"));
    const path = join(root, "control.sock");
    const server = await startControlServer(path, {
      status,
      async restart() {},
    });
    const client = createConnection(path);
    await once(client, "connect");
    client.write("GET /v1/status HTTP/1.1\r\nHost:");
    const startedAt = Date.now();
    await closeControlServer(server, path);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    client.destroy();
  });

  test("refuses a non-socket stale control path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentstack-control-"));
    const path = join(root, "control.sock");
    await writeFile(path, "owned file");
    await expect(
      startControlServer(path, { status, async restart() {} }),
    ).rejects.toThrow("unsafe existing control path");
  });

  test("omits unknown-request URL and relative query data from logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentstack-control-"));
    const path = join(root, "control.sock");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const server = await startControlServer(path, {
      status,
      async restart() {},
    });
    servers.push({ server, path });
    await expect(
      controlRequest(
        path,
        "GET",
        "/missing?prompt=PRIVATE_SYNTHETIC_PROMPT&session=PRIVATE_SYNTHETIC_SESSION",
      ),
    ).rejects.toThrow("control request failed");
    const output = writes.join("");
    expect(output).not.toContain("PRIVATE_SYNTHETIC_PROMPT");
    expect(output).not.toContain("PRIVATE_SYNTHETIC_SESSION");
    expect(output).not.toContain("/missing");
    expect(output).not.toContain("prompt=");
    expect(output).not.toContain("session=");
    expect(JSON.parse(output)).toMatchObject({
      component: "control",
      event: "unknown_request",
      method: "GET",
    });
    expect(JSON.parse(output).requestId).toMatch(/^[a-f0-9-]{36}$/);
  });

  test("rejects components without safe System inventory metadata", () => {
    const component = status().systemInventory.components[0]!;
    expect(() =>
      assertValidProcessComponents([
        { ...component, inventory: { ...component.inventory, summary: "" } },
      ]),
    ).toThrow("lacks safe inventory metadata");
  });

  test("reports auth-required as degraded rather than healthy", () => {
    const response = status();
    response.children.codex.readiness = "auth-required";
    expect(statusExitCode(true, response)).toBe(4);
  });

  test("reports incompatible readiness as exit 5", () => {
    const response = status();
    response.children.codex.readiness = "incompatible";
    expect(statusExitCode(true, response)).toBe(5);
  });
});
