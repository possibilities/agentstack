import { lstat, mkdir, rm, rmdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { operation, serveSocket, publishedJsonSchema, localOrigin, withLocalAuth } from "@stack/api";
import { inspectConnection } from "@stack/access/connection-client";
import { renderQr } from "@stack/access/qr";
import { execFile } from "node:child_process";
import { clientInputs, clientOutputs, clientDescriptions, type ClientOperation, type ClientInput, type ClientOutput, type Release, type PlatformConfiguration } from "./contract.js";
import { ClientState } from "./state.js";
import { Connections, tailnetPeers } from "./connections.js";
import { installPlan, installRelease } from "./install.js";
import { PlatformService } from "./service.js";

const safeError = (error: unknown) => error instanceof Error && /^[a-z][a-z0-9_]{1,79}$/.test(error.message) ? error.message : "client_operation_failed";

/** Same-user host, deliberately independent of the Stack process and its API fleet. */
export async function startClientHost(options: { root?: string; uiOrigin?: string } = {}) {
  if (options.uiOrigin) localOrigin(options.uiOrigin);
  const state = new ClientState(options.root);
  const service = new PlatformService(state), connections = new Connections(state);
  const pending = new Set<Promise<void>>();
  const controller = new AbortController();
  let notify = () => {}, closed = false, serial: Promise<unknown> = Promise.resolve();
  const job = (name: string, input: { requestId: string }, execute: (stage: (name: string) => void) => Promise<void>) => {
    const admitted = state.transaction(() => state.admit(input.requestId, name, input));
    if (!admitted.duplicate) {
      const work = Promise.resolve().then(async () => {
        try {
          await execute(stage => { state.progress(input.requestId, stage); notify(); });
          state.progress(input.requestId, "finished", "completed");
        } catch (error) {
          // Service-manager failure may have acted before returning. Do not claim a known negative.
          const stage = state.job(input.requestId)?.stage;
          state.progress(input.requestId, "finished", name === "client_install" && !controller.signal.aborted && stage !== "runtime_install" && stage !== "selecting" ? "failed" : "unknown", safeError(error));
        }
        notify();
      }).finally(() => pending.delete(work));
      pending.add(work);
    }
    notify(); return admitted;
  };
  async function dispatch(name: ClientOperation, input: any): Promise<unknown> {
    switch (name) {
      case "client_prerequisites": return { platform: process.platform, architecture: process.arch, nodeVersion: process.version,
        supported: process.platform === "darwin" && process.arch === "arm64" || process.platform === "linux" && process.arch === "x64",
        dependencies: await Promise.all(["python3", "gh"].map(name => new Promise<{ name: string; available: boolean }>(resolve =>
          execFile(name, ["--version"], { timeout: 10_000, maxBuffer: 65_536 }, error => resolve({ name, available: !error }))))),
        serviceAvailable: (await service.observe()).available };
      case "client_qr_render": return renderQr(input.text);
      case "client_snapshot": return { version: 1, root: state.root, installation: state.read<Release>("installation")?.value ?? null,
        service: await service.observe(), configuration: { revision: state.read("configuration")?.revision ?? 0,
          saved: state.read<PlatformConfiguration>("configuration")?.value ?? {},
          pending: (state.read("configuration")?.revision ?? 0) !== (state.read<number>("configuration-applied")?.value ?? 0) },
        connections: connections.list(), pending: connections.pending(), jobs: state.jobs() };
      case "client_job_get": { const result = state.job(input.id); if (!result) throw new Error("job_not_found"); return result; }
      case "client_install_plan": return installPlan(state, input.release);
      case "client_install": return job(name, input, async progress => {
        const status = await service.observe();
        if (status.owned && !status.available) throw new Error("service_observation_unavailable");
        if (status.running || status.ready) throw new Error("platform_stop_required");
        await installRelease(state, input.release, progress, controller.signal);
      });
      case "client_platform_start": return job(name, input, async progress => { progress("starting_service"); await service.start(); });
      case "client_platform_stop": return job(name, input, async progress => { progress("stopping_service"); await service.stop(); });
      case "client_login_set": return job(name, input, async progress => {
        state.write("login", input.enabled); progress("configuring_login"); await service.configure(input.enabled);
      });
      case "client_platform_configure": return state.transaction(() => {
        if ((state.read("configuration")?.revision ?? 0) !== input.expectedRevision) throw new Error("revision_conflict");
        state.write("configuration", input.configuration); return { revision: state.read("configuration")!.revision, applied: false };
      });
      case "client_local_open": return service.open();
      case "client_ui_connect": {
        if (!options.uiOrigin) throw new Error("client_ui_not_configured");
        const token = withLocalAuth({ STACK_STATE_DIR: state.root }, auth => auth.bootstrap(options.uiOrigin!, "ui"));
        return { url: `${options.uiOrigin}/connect/local#${token}`, expiresInSeconds: 60 };
      }
      case "client_tailnet_peers": return tailnetPeers();
      case "client_connection_inspect": return inspectConnection(input.origin);
      case "client_connection_list": return { connections: connections.list(), pending: connections.pending() };
      case "client_pair_begin": return connections.pair(input);
      case "client_pair_redeem": { const old = state.read<{ connectionId: string }>(`paired:${input.id}`)?.value;
        return old ? { connectionId: old.connectionId } : connections.redeemPairing(input.id); }
      case "client_enrollment_begin": return connections.enroll(input);
      case "client_enrollment_accept": return connections.accept(input.id, input.receipt);
      case "client_enrollment_redeem": { const old = state.read<{ connectionId: string }>(`paired:${input.id}`)?.value;
        return old ? { connectionId: old.connectionId } : connections.redeemEnrollment(input.id); }
      case "client_connection_open": return connections.open(input.id, input.requestId);
      case "client_connection_forget": return connections.forget(input.id, input.expectedRevision);
      case "client_intent_forget": return connections.forgetIntent(input.kind, input.id, input.expectedRevision);
    }
  }
  function call<K extends ClientOperation>(name: K, raw: ClientInput<K>): Promise<ClientOutput<K>> {
    if (closed) return Promise.reject(new Error("client_host_closed"));
    let input: unknown;
    try { input = clientInputs[name].parse(raw); } catch (error) { return Promise.reject(error); }
    const result = serial.then(async () => clientOutputs[name].parse(await dispatch(name, input)) as ClientOutput<K>);
    serial = result.catch(() => {});
    return result.finally(() => { if (!name.endsWith("_get") && !["client_snapshot", "client_connection_list", "client_install_plan", "client_tailnet_peers", "client_connection_inspect"].includes(name)) notify(); });
  }
  const operations = Object.entries(clientInputs).map(([name, input]) => operation({ name,
    description: clientDescriptions[name as ClientOperation], input, output: clientOutputs[name as ClientOperation],
    async call(_ctx: object, args: any) { return call(name as ClientOperation, args); } }));
  const path = join(state.root, "client.sock"), lock = `${path}.starting`;
  let locked = false;
  let socket: Awaited<ReturnType<typeof serveSocket>> | undefined;
  try {
    await mkdir(lock, { mode: 0o700 }); locked = true;
    const old = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (old) {
      if (!old.isSocket()) throw new Error("client_socket_conflict");
      const result = await new Promise<string>(resolve => {
        const socket = connect(path); const finish = (value: string) => { socket.destroy(); resolve(value); };
        socket.setTimeout(1000, () => finish("timeout")); socket.once("connect", () => finish("connected"));
        socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? "error"));
      });
      if (result !== "ECONNREFUSED") throw new Error("client_host_busy");
      const current = await lstat(path);
      if (!current.isSocket() || current.ino !== old.ino || current.dev !== old.dev) throw new Error("client_socket_changed");
      await rm(path);
    }
    socket = await serveSocket({ info: { name: "client", description: "Local Stack client host", transportDescription: "Private same-user client control; never remotely exposed", path },
      context: {}, operations, events: { topics: { client_changed: "Client installation, job or connection changed. Read client_snapshot; notices contain no credentials." } } });
    state.interrupted(); withLocalAuth({ STACK_STATE_DIR: state.root }, auth => auth.rotateForStartup());
    const served = socket;
    notify = () => served.publish?.("client_changed");
    return { path, call, catalog: () => operations.map(op => ({ name: op.name, description: op.description,
      inputSchema: publishedJsonSchema(op.input), outputSchema: publishedJsonSchema(op.output) })),
      async close() {
        closed = true; controller.abort();
        await serial; await Promise.allSettled(pending); await served.close(); state.close();
      } };
  } catch (error) { await socket?.close(); state.close(); throw error; }
  finally { if (locked) await rmdir(lock); }
}
