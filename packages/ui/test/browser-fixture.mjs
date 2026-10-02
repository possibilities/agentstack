// Shared setup for the optional rendered checks and the gateway-backed store test. Not a test file itself.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPackage, withLocalAuth, localCookieName } from "@stack/api";

/** Authenticate a disposable rendered fixture; production bootstrap is tested separately. */
export async function authorizeBrowser(page, origin, env) {
  const session = withLocalAuth(env, auth => auth.redeem(auth.bootstrap(origin, "ui"), origin, "ui"));
  await page.context().addCookies([{ name: localCookieName("ui"), value: session.token, url: origin, httpOnly: true, sameSite: "Strict" }]);
}

export const ui = dirname(dirname(fileURLToPath(import.meta.url)));
export const root = dirname(dirname(ui));

// Socket listings publish JSON Schemas (ADR 0096), so fixture operations need real zod types.
// ui itself has no zod dependency; borrow the api package's.
export const { z } = await import(pathToFileURL(createRequire(join(root, "packages", "api", "package.json")).resolve("zod")).href);
/** Accepts and returns any object; for fixture operations whose shape the check does not exercise. */
export const anyObject = z.looseObject({});
export const passthrough = z.unknown();

/** Synthetic manifests for fixtures implementing only a subset of a real package. */
export async function fixtureWorkspace(directory, names) {
  const workspace = join(directory, "workspace");
  for (const name of names) {
    const dir = join(workspace, "packages", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "api.yaml"), `name: ${name}\ndescription: Fixture.\nsocket:\n  description: Fixture.\nwebsocket:\n  description: Fixture.\n  operations: all\n  events: all\n`);
  }
  return workspace;
}

export function transport(endpoint, operations = [], events = [], type = "websocket") {
  return { type, endpoint, description: "Isolated fixture", supported: true, subscriptions: events.length > 0, operations, workerOperations: [], workerEvents: [], events, routes: [] };
}

/**
 * The WebSocket gateway admits a connection only when every package it configures answers on its
 * socket, so give it a workspace root holding just the manifests of the packages a check serves.
 */
export async function gatewayRoot(dir, names, synthetic = []) {
  const gateway = join(dir, "gateway");
  for (const name of names) {
    await mkdir(join(gateway, "packages", name), { recursive: true });
    if (synthetic.includes(name)) await writeFile(join(gateway, "packages", name, "api.yaml"), `name: ${name}\ndescription: Fixture.\nsocket:\n  description: Fixture.\nwebsocket:\n  description: Fixture.\n  operations: all\n  events: all\n`);
    else await copyFile(join(root, "packages", name, "api.yaml"), join(gateway, "packages", name, "api.yaml"));
  }
  return gateway;
}

/** Socket operations answered by `handlers[name]()`, with schemas the gateway can list. */
export function fixtureOperations(names, handlers) {
  return names.map((name) => ({ name, description: name, input: anyObject, output: z.any(), async call(_ctx, input) { return handlers[name](input); } }));
}

/** A discovery document for `docs_snapshot`, pointing every operation and topic at one WebSocket. */
export function fixtureDoc(name, api, endpoint, publishedJsonSchema) {
  const operations = api?.operations ?? [];
  const topics = api?.events?.topics ?? {};
  return { name, packageName: `@stack/${name}`, description: `${name} fixture`, events: topics, eventScope: null,
    transports: [{ type: "websocket", description: "Isolated fixture", supported: true, subscriptions: true, endpoint,
      operations: operations.map((operation) => operation.name), workerOperations: [], workerEvents: [], events: Object.keys(topics), routes: [] }],
    operations: operations.map((operation) => ({ name: operation.name, title: operation.annotations?.title ?? null, description: operation.description,
      annotations: operation.annotations ?? {}, inputSchema: publishedJsonSchema(operation.input), outputSchema: publishedJsonSchema(operation.output) })) };
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

const unobserved = (name) => () => { throw new Error(`${name} is not observed in this fixture`); };
const noResources = () => ({
  observation: { snapshotId: null, capturedAt: null, ageMs: null, freshness: "unavailable", lastAttemptAt: null, error: "server_missing", source: "unsupported", intervalMs: 5_000, staleAfterMs: 15_000, collectionDurationMs: null, coverage: null },
  host: null, capabilities: { rssBytes: false, virtualBytes: false, cpuTimeMs: false, cpuPercent: false, threads: false, diskIoBytes: false, openFileDescriptors: false, networkBytes: false, gpu: false, perSessionAllocation: false },
  retention: { maxSamples: 0, maxProcessRecords: 0, retainedSamples: 0, oldestAttemptAt: null, newestAttemptAt: null, droppedSamples: 0 }, runtime: null,
  scopes: [], processes: [], page: { offset: 0, limit: 100, total: 0, nextOffset: null },
});

/**
 * A `serve` fixture the WebSocket gateway admits: it answers every operation the real serve
 * manifest selects and declares every real topic, so a new serve operation can't silently stop
 * a check from connecting. A check's own `serve_*` handlers take precedence; other reads report no
 * observation (resources unavailable, Codex tools and history unobserved). Global settings read as the
 * server's default, so developer mode is off and its release reads stay unobserved.
 */
export async function serveFixture(handlers = {}) {
  const overrides = Object.fromEntries(Object.entries(handlers).filter(([name]) => name.startsWith("serve_")));
  const { config } = await findPackage(root, "serve");
  const names = config.websocket?.operations;
  if (!Array.isArray(names)) throw new Error("serve must select explicit WebSocket operations");
  const { topics } = await import(pathToFileURL(join(root, "packages", "serve", "dist", "api.js")).href);
  const served = {
    serve_status: () => ({ pid: process.pid, startedAt: new Date().toISOString(), nodeVersion: process.version, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
    serve_resources: noResources,
    serve_settings_read: () => ({ developerMode: false, revision: 0, updatedAt: null }),
    ...overrides,
  };
  for (const name of names) served[name] ??= unobserved(name);
  return { names, topics: Object.fromEntries(Object.keys(topics).map((topic) => [topic, "Fixture"])), handlers: served };
}
