import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChildId,
  ProcessComponent,
  StatusResponse,
} from "@agentstack/contracts";
import { CONTROL_SCHEMA, createSystemInventory } from "@agentstack/contracts";
import { createCodexProbe } from "@agentstack/harness-codex";
import { fxProbe } from "@agentstack/harness-fx";
import {
  ManagedChild,
  closeControlServer,
  ensureRuntimePaths,
  log,
  resolveRuntimePaths,
  startControlServer,
} from "@agentstack/runtime";

interface EngineManifest {
  version: string;
  executable: string;
  args: string[];
  sha256: string;
  source: unknown;
}

function sourceIdentity(source: unknown): string {
  if (typeof source === "string" && source.trim()) return source;
  if (typeof source === "object" && source !== null) {
    const value = source as Record<string, unknown>;
    const repository = value.repository ?? value.url ?? value.package;
    const revision = value.commit ?? value.version ?? value.archiveSha256;
    if (typeof repository === "string")
      return `${repository}${typeof revision === "string" ? `@${revision}` : ""}`;
  }
  return "product-vendored";
}

interface ReleaseManifest {
  schemaVersion: number;
  productVersion: string;
  buildIdentity: string;
  target: string;
  engines: Record<ChildId, EngineManifest>;
}

const entrypoint = fileURLToPath(import.meta.url);
const releaseRoot = resolve(
  process.env.AGENTSTACK_RELEASE_ROOT ?? join(dirname(entrypoint), ".."),
);
const paths = resolveRuntimePaths();
const generation = randomUUID();
const startedAt = new Date().toISOString();

async function readManifest(path: string): Promise<ReleaseManifest> {
  return JSON.parse(await readFile(path, "utf8")) as ReleaseManifest;
}

function childEnvironment(engineHome: string): Record<string, string> {
  return {
    HOME: engineHome,
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    TERM: "dumb",
  };
}

async function main(): Promise<void> {
  await ensureRuntimePaths(paths);
  const manifest = await readManifest(join(releaseRoot, "manifest.json"));
  let installedVersion = manifest.productVersion;
  try {
    installedVersion = (
      await readManifest("/usr/lib/agentstack/current/manifest.json")
    ).productVersion;
  } catch {
    // Development and removed-package foreground runs have no packaged current link.
  }

  const children = {
    codex: new ManagedChild(
      {
        id: "codex",
        sourceVersion: manifest.engines.codex.version,
        command: resolve(releaseRoot, manifest.engines.codex.executable),
        args: manifest.engines.codex.args,
        cwd: paths.codexHome,
        env: {
          ...childEnvironment(paths.codexHome),
          CODEX_HOME: paths.codexHome,
        },
        probe: createCodexProbe(manifest.productVersion),
      },
      () => undefined,
    ),
    fx: new ManagedChild(
      {
        id: "fx",
        sourceVersion: manifest.engines.fx.version,
        command: resolve(releaseRoot, manifest.engines.fx.executable),
        args: manifest.engines.fx.args.map((arg) =>
          arg === "${FX_STATE_DIR}" ? paths.fxHome : arg,
        ),
        cwd: paths.fxHome,
        env: childEnvironment(paths.fxHome),
        probe: fxProbe,
      },
      () => undefined,
    ),
  };

  const status = (): StatusResponse => {
    const childStatus = {
      codex: children.codex.status(),
      fx: children.fx.status(),
    };
    const childComponent = (id: ChildId): ProcessComponent => {
      const child = childStatus[id];
      const engine = manifest.engines[id];
      return {
        id,
        name: id === "codex" ? "Codex app-server" : "Fx ACP",
        kind: "engine",
        owner: "agentstack-daemon",
        desiredState: child.desiredState,
        observedState: child.observedState,
        pid: child.pid,
        version: child.sourceVersion,
        build: engine.sha256,
        source: sourceIdentity(engine.source),
        startedAt: child.startedAt,
        uptimeMs: child.uptimeMs,
        readiness: child.readiness,
        generation: child.generation,
        restartCount: child.restartCount,
        lastFailure: child.lastFailure,
        inventory: {
          summary:
            id === "codex"
              ? "Pinned Codex app-server stdio engine"
              : "Pinned Fx Agent Client Protocol stdio engine",
          capabilities: [
            {
              id: id === "codex" ? "app-server.initialize" : "acp.initialize",
              name: "Protocol readiness",
              summary: "Answers an inference-free initialization exchange",
            },
          ],
          preferences: [
            {
              id: "state-root",
              name: "Private state root",
              valueType: "path",
              mutable: false,
              sensitive: false,
              summary: "Product-owned isolated engine state directory",
            },
          ],
        },
      };
    };
    const components: ProcessComponent[] = [
      {
        id: "daemon",
        name: "AgentStack daemon",
        kind: "daemon",
        owner: "systemd-user",
        desiredState: "running",
        observedState: "running",
        pid: process.pid,
        version: manifest.productVersion,
        build: manifest.buildIdentity,
        source: "agentstack",
        startedAt,
        uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
        readiness: "ready",
        generation,
        restartCount: 0,
        lastFailure: null,
        inventory: {
          summary: "Owns engine processes, lifecycle and local control",
          capabilities: [
            {
              id: "process.status",
              name: "Process registry",
              summary: "Reports safe component identity and runtime status",
            },
            {
              id: "engine.restart",
              name: "Engine restart",
              summary: "Restarts one owned engine by stable component ID",
            },
          ],
          preferences: [
            {
              id: "session-service",
              name: "Session service",
              valueType: "boolean",
              mutable: false,
              sensitive: false,
              summary: "Runs only in the current user's login sessions",
            },
          ],
        },
      },
      childComponent("codex"),
      childComponent("fx"),
    ];
    const systemInventory = createSystemInventory(components);
    return {
      schema: CONTROL_SCHEMA,
      productVersion: manifest.productVersion,
      installedVersion,
      runningVersion: manifest.productVersion,
      buildIdentity: manifest.buildIdentity,
      installPath: releaseRoot,
      daemon: {
        generation,
        pid: process.pid,
        startedAt,
        desiredState: "running",
      },
      systemInventory,
      children: childStatus,
    };
  };

  const control = await startControlServer(paths.controlSocket, {
    status,
    async restart(id) {
      await children[id].restart();
    },
  });

  await Promise.all([children.codex.start(), children.fx.start()]);
  log({
    level: "info",
    component: "daemon",
    event: "ready",
    generation,
    releaseRoot,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({
      level: "info",
      component: "daemon",
      event: "shutdown_started",
      generation,
      signal,
    });
    await closeControlServer(control, paths.controlSocket).catch(
      () => undefined,
    );
    await Promise.all([children.codex.stop(), children.fx.stop()]);
    log({
      level: "info",
      component: "daemon",
      event: "shutdown_complete",
      generation,
      signal,
    });
    process.exit(exitCode);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("uncaughtException", (error) => {
    log({
      level: "error",
      component: "daemon",
      event: "uncaught_exception",
      generation,
      reason: String(error),
    });
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    log({
      level: "error",
      component: "daemon",
      event: "unhandled_rejection",
      generation,
      reason: String(error),
    });
    void shutdown("unhandledRejection", 1);
  });
}

void main().catch((error) => {
  log({
    level: "error",
    component: "daemon",
    event: "startup_failed",
    generation,
    reason: String(error),
  });
  process.exitCode = 1;
});
