// Shared setup for the optional rendered checks and the gateway-backed store test. Not a test file itself.
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const uix = dirname(dirname(fileURLToPath(import.meta.url)));
export const root = dirname(dirname(uix));

// Socket listings publish JSON Schemas (ADR 0096), so fixture operations need real zod types.
// uix itself has no zod dependency; borrow the api package's.
export const { z } = await import(pathToFileURL(createRequire(join(root, "packages", "api", "package.json")).resolve("zod")).href);
/** Accepts and returns any object; for fixture operations whose shape the check does not exercise. */
export const anyObject = z.looseObject({});

/**
 * The WebSocket gateway admits a connection only when every package it configures answers on its
 * socket, so give it a workspace root holding just the manifests of the packages a check serves.
 */
export async function gatewayRoot(dir, names) {
  const gateway = join(dir, "gateway");
  for (const name of names) {
    await mkdir(join(gateway, "packages", name), { recursive: true });
    await copyFile(join(root, "packages", name, "api.yaml"), join(gateway, "packages", name, "api.yaml"));
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
  return { name, packageName: `@agentstack/${name}`, description: `${name} fixture`, events: topics, eventScope: null,
    transports: [{ type: "websocket", description: "Isolated fixture", supported: true, subscriptions: true, endpoint,
      operations: operations.map((operation) => operation.name), events: Object.keys(topics), routes: [] }],
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
