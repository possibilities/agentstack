// Owns the installed-package contract, not another rendering fixture: npm packs
// and installs offline in a fresh HOME/cache/prefix, then the actual bin runs
// with Node filesystem permissions that make the repository unreadable.
// STACK_UI_STAGE=/absolute/candidate CLIENT_PORTABLE_EVIDENCE_DIR=/scratch/... node test/client-portable-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function run(command, args, options, log) {
  const { open } = await import("node:fs/promises");
  const file = await open(log, "w");
  const errors = await open(`${log}.stderr`, "w");
  try {
    return await new Promise((done, reject) => {
      const child = spawn(command, args, { ...options, stdio: ["ignore", file.fd, errors.fd] });
      let force, timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        force = setTimeout(() => child.kill("SIGKILL"), 8000);
      }, 180_000);
      child.once("error", error => { clearTimeout(timer); clearTimeout(force); reject(error); });
      child.once("exit", code => {
        clearTimeout(timer); clearTimeout(force);
        code === 0 && !timedOut ? done() : reject(new Error(`command_failed:${timedOut ? "timeout" : code}:${log}`));
      });
    });
  } finally { await file.close(); await errors.close(); }
}
async function executable(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const path = join(dir, name);
    if (await access(path, constants.X_OK).then(() => true, () => false)) return realpath(path);
  }
  return null;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once("exit", done));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
  await exited; clearTimeout(timer);
}

if (process.argv[2] === "--run") {
  const [installed, base] = process.argv.slice(3);
  const require = createRequire(join(installed, "package.json"));
  const { socketCall, listPackages, workspaceRoot } = await import(pathToFileURL(require.resolve("@stack/api")));
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, "@stack/ui");
  assert.equal(manifest.engines.node, ">=24");
  assert.equal(workspaceRoot(installed), installed);
  const packages = await listPackages(installed);
  assert.ok(packages.some(({ config }) => config.name === "serve" && config.websocket), "installed api.yaml resources support discovery");
  let files = 0;
  async function inventory(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        assert.ok((await realpath(path)).startsWith(`${installed}/`), "npm-created bin links stay within the installed package");
        continue;
      }
      if (entry.isDirectory()) await inventory(path);
      else {
        files++;
        if (entry.name === "package.json") {
          const item = JSON.parse(await readFile(path, "utf8"));
          assert.ok(!JSON.stringify(item).includes("workspace:"), "all installed manifests are materialized");
          for (const key of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"])
            assert.ok(!item.scripts?.[key], "installed runtime does not execute dependency lifecycle scripts");
        }
      }
    }
  }
  await inventory(installed);
  assert.ok(!Object.keys(manifest.dependencies).some(name => name === "shadcn" || name.includes("tree-sitter") || name.includes("watcher") || name.includes("msgpackr")));
  assert.ok(!await stat(join(installed, "server.js")).catch(() => null), "unguarded generated standalone entry point is not shipped");
  assert.ok(!await stat(join(installed, "pnpm-workspace.yaml")).catch(() => null));
  const clientRoot = join(base, "c");
  const bin = join(base, "prefix", "bin", "stack-ui");
  const child = spawn(bin, ["--root", clientRoot, "--port", "0", "--no-open"], {
    cwd: join(base, "outside"), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", bytes => { output = (output + bytes).slice(-8192); });
  child.stderr.on("data", bytes => { output = (output + bytes).slice(-8192); });
  child.once("error", error => { output += error.code; });
  const interrupted = () => void stop(child).then(() => process.exit(1));
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  try {
    let origin;
    for (let n = 0; n < 600; n++) {
      origin = /ready at (http:\/\/127\.0\.0\.1:\d+)\/client/.exec(output)?.[1];
      if (origin) break;
      if (child.exitCode !== null) throw new Error(`installed_launcher_failed:${output}`);
      await sleep(100);
    }
    assert.ok(origin, "installed CLI reports readiness without a bootstrap secret");
    assert.ok(!output.includes("#"));
    const response = (path, init) => fetch(`${origin}${path}`, { ...init, redirect: "manual" });
    let result = await response("/client");
    assert.equal(result.status, 401); await result.body?.cancel();
    const bootstrap = await socketCall(join(clientRoot, "client.sock"), "tools/call", { name: "client_ui_connect", arguments: {} });
    const token = new URL(bootstrap.url).hash.slice(1);
    // Exercise the real fragment exchange; never print or persist the capability.
    result = await response("/connect/local/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(result.status, 200);
    const cookie = result.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^stack_client_ui_/);
    assert.ok(result.headers.get("set-cookie").includes("HttpOnly"));
    await result.body?.cancel();
    result = await response("/connect/local/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(result.status, 401); await result.body?.cancel();
    result = await response("/client", { headers: { cookie } });
    assert.equal(result.status, 200);
    const html = await result.text();
    assert.match(html, /<h1[^>]*>Connections<\/h1>/, "installed Client shell renders before asynchronous snapshot loading");
    assert.ok(result.headers.get("content-security-policy").includes("'nonce-"));
    assert.equal(result.headers.get("cache-control"), "no-store");
    const asset = /src="([^" ]*\/_next\/static\/[^" ]+\.js)"/.exec(html)?.[1];
    assert.ok(asset, "packaged static assets are referenced");
    result = await fetch(new URL(asset, origin), { headers: { cookie } });
    assert.equal(result.status, 200); await result.body?.cancel();
    result = await fetch(new URL(asset, origin));
    assert.equal(result.status, 401); await result.body?.cancel();
    result = await response("/client", { headers: { cookie, "x-forwarded-host": new URL(origin).host } });
    assert.equal(result.status, 403); await result.body?.cancel();
    result = await response("/api/client/rpc", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ operation: "client_snapshot", input: {} }) });
    if (result.status !== 200) throw new Error(`installed_snapshot_rpc_failed:${await result.text()}`);
    const { output: snapshot } = await result.json();
    assert.equal(snapshot.installation, null);
    assert.deepEqual(snapshot.jobs, []);
    assert.equal(snapshot.service.ready, false);
    assert.ok(snapshot.service.path.startsWith(process.env.HOME));
    result = await response("/client/local", { headers: { cookie } });
    assert.equal(result.status, 200);
    assert.ok((await result.text()).includes("No trusted release configured for this Client"));
    result = await response("/api/client/rpc", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ operation: "client_enrollment_begin", input: { requestId: randomUUID(), label: "Portable check", scopes: ["ui:view"] } }) });
    assert.equal(result.status, 200);
    const enrollment = (await result.json()).output;
    result = await response("/api/client/rpc", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ operation: "client_qr_render", input: { text: enrollment.text } }) });
    assert.equal(result.status, 200);
    assert.ok((await result.json()).output.rows.length > 0, "QR dependency closure works without a platform");
    const controller = new AbortController();
    result = await response("/api/client/events", { headers: { cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    assert.equal(result.status, 200);
    const event = await result.body.getReader().read();
    assert.ok(new TextDecoder().decode(event.value).includes("event: ready"));
    controller.abort();
    await stop(child);
    assert.ok(!await stat(join(clientRoot, "client.sock")).catch(() => null), "CLI shutdown releases the Client socket");
    assert.ok(!await stat(join(process.env.HOME, "Library", "LaunchAgents")).catch(() => null));
    assert.ok(!await stat(join(process.env.HOME, ".config", "systemd", "user")).catch(() => null));
    console.log(JSON.stringify({ status: "passed", installedFiles: files, engines: manifest.engines,
      checks: ["offline bundled install", "installed Package API discovery", "actual stack-ui bin", "one-use fragment exchange", "authenticated client/Local/QR/RPC/SSE/assets", "pre-Next forwarding refusal", "cold platform", "supervised shutdown", "no service registration", "repository denied by Node permissions"] }));
  } finally {
    process.removeListener("SIGTERM", interrupted); process.removeListener("SIGINT", interrupted);
    await stop(child);
  }
} else {
  const stage = resolve(process.env.STACK_UI_STAGE ?? join(dirname(script), "..", "dist", "package"));
  const npm = await executable("npm");
  if (Number(process.versions.node.split(".")[0]) < 24 || !npm
    || !await stat(join(stage, "packaging.json")).catch(() => null)
    || !await stat(join(stage, "package.json")).catch(() => null)) {
    console.log("SKIP portable Client check: requires Node >=24, npm and a completed `pnpm --filter @stack/ui run stage` candidate.");
    process.exit(0);
  }
  assert.ok(!npm.includes("/worktrees/") && !npm.startsWith(resolve(dirname(script), "../../..")), "npm prerequisite must be installed outside the repository");
  const base = await realpath(await mkdtemp("/tmp/s8d-")); // /tmp is a symlink on macOS; permissions need the canonical short path.
  const evidence = process.env.CLIENT_PORTABLE_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const home = join(base, "h"), cache = join(base, "cache"), prefix = join(base, "prefix"), tools = join(base, "tools");
  for (const dir of [home, cache, prefix, tools, join(base, "outside"), join(base, "pack")]) await mkdir(dir);
  await symlink(process.execPath, join(tools, "node"));
  await writeFile(join(base, "user.npmrc"), "");
  await writeFile(join(base, "global.npmrc"), "");
  // Observation-only service-manager stand-ins refuse every mutating command.
  for (const name of ["launchctl", "systemctl"]) await writeFile(join(tools, name), `#!/usr/bin/env node
if (${JSON.stringify(name)} === "launchctl" && process.argv[2] === "print") process.exit(113);
if (${JSON.stringify(name)} === "systemctl" && process.argv.includes("show")) { console.log("LoadState=not-found"); process.exit(4); }
throw new Error("service_mutation_refused");
`, { mode: 0o755 });
  const env = { HOME: home, PATH: tools, TMPDIR: base, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
    npm_config_userconfig: join(base, "user.npmrc"), npm_config_globalconfig: join(base, "global.npmrc"), npm_config_cache: cache, npm_config_prefix: prefix,
    NEXT_TELEMETRY_DISABLED: "1", STACK_STATE_DIR: join(base, "p"), STACK_WEBSOCKET_PORT: "0" };
  const logs = ["pack.json", "install.log", "runtime.log", "permission-negative.log"].flatMap(name => [name, `${name}.stderr`]);
  try {
    await run(process.execPath, [npm, "pack", stage, "--ignore-scripts", "--json", "--pack-destination", join(base, "pack")], { cwd: join(base, "outside"), env }, join(base, "pack.json"));
    const [pack] = JSON.parse(await readFile(join(base, "pack.json"), "utf8"));
    const tarball = join(base, "pack", pack.filename);
    // Packing may write npm logs/cache bookkeeping. Installation gets an empty
    // cache of its own, not a warmed cache that could hide missing dependencies.
    await rm(cache, { recursive: true, force: true }); await mkdir(cache);
    await run(process.execPath, [npm, "install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", tarball], { cwd: join(base, "outside"), env }, join(base, "install.log"));
    const installed = join(prefix, "lib", "node_modules", "@stack", "ui");
    await copyFile(script, join(base, "verify.mjs"));
    const permissions = ["--permission", `--allow-fs-read=${base}`, `--allow-fs-write=${base}`, "--allow-child-process", "--allow-worker"];
    // Node 26 also gates loopback/Unix sockets; Node 24's filesystem model does not.
    if (process.allowedNodeEnvironmentFlags.has("--allow-net")) permissions.push("--allow-net");
    env.NODE_OPTIONS = permissions.join(" ");
    // Validate the deny boundary against a real text file before relying on it.
    await run(process.execPath, ["--input-type=module", "-e", `import {readFile} from "node:fs/promises"; import assert from "node:assert/strict"; await assert.rejects(readFile(${JSON.stringify(join(dirname(script), "..", "package.json"))}, "utf8"), {code:"ERR_ACCESS_DENIED"}); console.log("PASS repository read denied");`], { cwd: join(base, "outside"), env }, join(base, "permission-negative.log"));
    await run(process.execPath, [join(base, "verify.mjs"), "--run", installed, base], { cwd: join(base, "outside"), env }, join(base, "runtime.log"));
    const summary = { status: "passed", npmName: pack.name, version: pack.version, size: pack.size, unpackedSize: pack.unpackedSize,
      fileCount: pack.entryCount, integrity: pack.integrity, engines: { node: ">=24" },
      runtime: JSON.parse((await readFile(join(base, "runtime.log"), "utf8")).trim().split("\n").at(-1)),
      node: process.version, platform: process.platform, architecture: process.arch,
      install: "offline, empty cache, fresh HOME/prefix, ignore-scripts", runtimeAuthority: "only disposable /tmp tree readable/writable; no pnpm on PATH" };
    if (evidence) {
      await writeFile(join(evidence, "portable-summary.json"), JSON.stringify(summary, null, 2) + "\n");
      await copyFile(tarball, join(evidence, pack.filename));
    }
    console.log(JSON.stringify(summary));
  } finally {
    if (evidence) for (const log of logs) await copyFile(join(base, log), join(evidence, log)).catch(() => {});
    await rm(base, { recursive: true, force: true }); // Exact disposable tree owned by this check.
  }
}
