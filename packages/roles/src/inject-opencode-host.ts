// A process-local composition of the pinned public OpenCode server. Credentials,
// integration selection/refresh and session persistence stay native in the ordinary
// database. Only the database-backed source of ambient capabilities is replaced.
import { createServer } from "node:http";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { createRoutes } from "@opencode/server/routes";
import { WellKnown } from "@opencode/core/wellknown";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

const password = process.env.OPENCODE_PASSWORD;
const directory = process.env.OPENCODE_CONFIG_DIR;
if (!password || !directory) throw new Error("roles inject host requires private launch configuration");
// Do not let tools inherit the private listener's authentication credential.
delete process.env.OPENCODE_PASSWORD;
delete process.env.OPENCODE_SERVER_PASSWORD;
const unavailable = () => Effect.die(new Error("Well-known capabilities are disabled for this Role invocation"));
const overrides = [WellKnown.node.replace(Layer.succeed(WellKnown.Service, {
  entries: () => Effect.succeed([]), snapshot: () => [], refresh: () => Effect.succeed(false),
  add: unavailable, remove: unavailable, resolve: unavailable,
}))];
const truthy = (value?: string) => value === "1" || value?.toLowerCase() === "true";
const abort = new AbortController();
const stop = () => abort.abort();
process.stdin.once("end", stop).once("close", stop).resume();
process.once("SIGTERM", stop); process.once("SIGINT", stop); process.once("SIGHUP", stop);

const program = Effect.scoped(Effect.gen(function* () {
  const routes = createRoutes({
    app: { name: "opencode", version: "2.0.16", channel: "latest" }, password,
    // The pinned stable CLI uses opencode.db, resolved by native Global.data.
    // Preserve OPENCODE_DB, including relative paths and :memory:, verbatim.
    database: { path: process.env.OPENCODE_DB ?? "opencode.db" },
    config: { directory, project: false },
    models: { url: process.env.OPENCODE_MODELS_URL, file: process.env.OPENCODE_MODELS_PATH, fetch: !truthy(process.env.OPENCODE_DISABLE_MODELS_FETCH) },
    windows: { gitbash: process.env.OPENCODE_GIT_BASH_PATH },
    fs: {
      filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
      fff: process.env.OPENCODE_DISABLE_FFF === undefined ? process.platform !== "win32" : !truthy(process.env.OPENCODE_DISABLE_FFF),
    },
  }, () => [], overrides);
  const context = yield* Layer.build(routes.pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)));
  const listener = createServer();
  const server = yield* NodeHttpServer.make(() => listener, { host: "127.0.0.1", port: 0 });
  yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
  yield* server.serve(Context.get(context, HttpRouter.HttpRouter).asHttpEffect()).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
  console.log(JSON.stringify({ url: HttpServer.formatAddress(server.address) }));
  yield* Effect.never;
})).pipe(Effect.provide(NodeServices.layer));

try { await Effect.runPromise(program, { signal: abort.signal }); }
catch (error) { if (!abort.signal.aborted) throw error; }
finally {
  process.stdin.off("end", stop).off("close", stop).pause();
  process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop);
}
