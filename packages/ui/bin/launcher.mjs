import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startClientHost } from "@stack/client";
import { browserNavigation } from "./navigation.mjs";
import { loadTrustedRelease } from "../lib/client/release.mjs";

const ui = dirname(dirname(fileURLToPath(import.meta.url)));
async function checkPort(port) {
  const server = createServer();
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ port, host: "127.0.0.1", exclusive: true }, resolve); }); }
  catch { throw new Error("client_ui_port_busy"); }
  const chosen = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return chosen;
}

export async function startClientUi({ root = process.env.STACK_CLIENT_STATE_DIR ?? join(homedir(), ".local", "share", "stack-client"), port = 19000, releaseManifest = process.env.STACK_CLIENT_RELEASE_MANIFEST, navigation, open = true, signal } = {}) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("node_24_required");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_ui_port");
  const release = await loadTrustedRelease(releaseManifest);
  await access(join(ui, ".next", "BUILD_ID")).catch(() => { throw new Error("client_ui_build_required"); });
  // A staged distribution pins Next's serialized configuration rather than
  // consulting source config or loading a TypeScript compiler at startup.
  const portableConfig = await readFile(join(ui, "next-runtime.json"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const origin = `http://127.0.0.1:${await checkPort(port)}`;
  if (signal?.aborted) throw new Error("client_ui_cancelled");
  const host = await startClientHost({ root: resolve(root), uiOrigin: origin });
  const adapter = navigation ?? browserNavigation(origin);
  let child, closing;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const close = () => closing ??= (async () => {
    signal?.removeEventListener("abort", abort);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited; clearTimeout(timer);
    }
    await host.close();
    resolveClosed();
  })();
  const abort = () => void close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    root = await realpath(resolve(root));
    if (signal?.aborted) throw new Error("client_ui_cancelled");
    child = spawn(process.execPath, [join(ui, "bin", "client-server.mjs")], { cwd: ui,
      env: { ...process.env, STACK_UI_MODE: "client", STACK_CLIENT_STATE_DIR: root, STACK_CLIENT_UI_ORIGIN: origin,
        // Always replace ambient child configuration, including the unset case.
        STACK_CLIENT_UI_RELEASE: release ? JSON.stringify(release) : "",
        // Replace, never inherit, an ambient standalone configuration.
        __NEXT_PRIVATE_STANDALONE_CONFIG: portableConfig,
        STACK_CLIENT_UI_INGRESS_KEY: randomBytes(32).toString("hex"), NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" },
      // Next's request/error logs must never echo capability POSTs or headers.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("client_ui_readiness_timeout")), 60_000);
      const done = (fn, value) => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", error); fn(value); };
      const message = value => { if (value?.ready === true) done(resolve); else if (value?.error) done(reject, new Error(value.error === "client_ui_port_busy" ? value.error : "client_ui_start_failed")); };
      const exit = () => done(reject, new Error("client_ui_start_failed"));
      const error = () => done(reject, new Error("client_ui_start_failed"));
      child.on("message", message); child.once("exit", exit); child.once("error", error);
    });
    child.once("exit", () => void close());
    if (signal?.aborted || closing) throw new Error("client_ui_cancelled");
    const readiness = await fetch(`${origin}/connect/local`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (!readiness.ok) throw new Error("client_ui_readiness_failed");
    await readiness.body?.cancel();
    if (open) {
      const bootstrap = await host.call("client_ui_connect", {});
      try { await adapter.openClientSurface(bootstrap.url); }
      catch { throw new Error("navigation_open_failed"); }
    }
    return { origin, root, host, navigation: adapter, close, closed };
  } catch (error) { await close(); throw error; }
}
