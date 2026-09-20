import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
});

function status(): StatusResponse {
  const child = (id: "codex" | "fx") => ({
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
  const components: ProcessComponent[] = ["daemon", "codex", "fx"].map(
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
    children: { codex: child("codex"), fx: child("fx") },
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
    await controlRequest(path, "POST", "/v1/children/fx/restart");
    expect(restarted).toEqual(["fx"]);
  });

  test("refuses a non-socket stale control path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentstack-control-"));
    const path = join(root, "control.sock");
    await writeFile(path, "owned file");
    await expect(
      startControlServer(path, { status, async restart() {} }),
    ).rejects.toThrow("unsafe existing control path");
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
    response.children.fx.readiness = "auth-required";
    expect(statusExitCode(true, response)).toBe(4);
  });
});
