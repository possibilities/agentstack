import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startClientHost } from "../src/host.js";
import { ClientState } from "../src/state.js";
import { PlatformService } from "../src/service.js";

// Opt-in native integration: uses only a unique label, disposable home/state and
// inert release process. No live Stack, runtime installer or GUI is involved.
test("launchd control fences foreign services, applies on explicit start, and outlives the client host", {
  skip: process.platform !== "darwin" || process.env.STACK_CLIENT_SERVICE_TEST !== "1",
}, async () => {
  const run = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "stack-client-service-"));
  const originalHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  let host: Awaited<ReturnType<typeof startClientHost>> | undefined;
  let target: string | undefined;
  async function job(name: "client_platform_start" | "client_platform_stop" | "client_login_set", enabled?: boolean) {
    const requestId = randomUUID();
    if (name === "client_login_set") await host!.call(name, { requestId, enabled: enabled! });
    else await host!.call(name, { requestId });
    for (let i = 0; i < 100; i++) {
      const result = await host!.call("client_job_get", { id: requestId });
      if (result.state !== "running") return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("job timeout");
  }
  async function running() {
    for (let i = 0; i < 30; i++) {
      const snapshot = await host!.call("client_snapshot", {});
      if (snapshot.service.running) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("service did not run");
  }
  try {
    await mkdir(process.env.HOME, { mode: 0o700 });
    const clientRoot = join(root, "client"), seed = new ClientState(clientRoot);
    const service = new PlatformService(seed);
    const domain = `gui/${process.getuid!()}`; target = `${domain}/${service.name}`;
    const sha256 = "a".repeat(64), bin = join(clientRoot, "releases", sha256, "bin");
    seed.write("installation", { version: "smoke", platform: "darwin", architecture: process.arch,
      url: "https://release.example/smoke.tgz", sha256, bytes: 1, unpackedBytes: 1 });
    seed.close();
    await mkdir(bin, { recursive: true });
    const fixture = join(root, "service.mjs");
    await writeFile(fixture, "console.log(JSON.stringify({event:'started',state:process.env.STACK_STATE_DIR,ui:process.env.STACK_UI_PORT??null}));setInterval(()=>{},1000);process.on('SIGTERM',()=>{console.log(JSON.stringify({event:'stopped'}));process.exit(0)});\n");
    await writeFile(join(bin, "stack"), `#!/bin/sh\nexec '${process.execPath}' '${fixture}'\n`, { mode: 0o700 });
    const foreign = join(root, "foreign.plist");
    await writeFile(foreign, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${service.name}</string><key>ProgramArguments</key><array><string>/bin/sleep</string><string>300</string></array><key>RunAtLoad</key><true/></dict></plist>`);
    await run("launchctl", ["bootstrap", domain, foreign]);
    host = await startClientHost({ root: clientRoot });
    await running();
    assert.equal((await job("client_login_set", false)).error, "service_not_owned");
    assert.equal((await host.call("client_snapshot", {})).service.running, true);
    await run("launchctl", ["bootout", target]);
    assert.equal((await job("client_platform_start")).state, "completed");
    const initial = await running();
    assert.deepEqual(initial.service.login, { saved: false, applied: false });
    assert.equal(initial.service.ready, false, "service completion is not Stack readiness");
    await host.call("client_platform_configure", { expectedRevision: 0, configuration: { ports: { ui: 19031 } } });
    assert.equal((await job("client_login_set", true)).state, "completed");
    const pending = await host.call("client_snapshot", {});
    assert.deepEqual(pending.service.login, { saved: true, applied: false });
    assert.equal(pending.configuration.pending, true);
    assert.equal((await job("client_platform_stop")).state, "completed");
    assert.equal((await host.call("client_snapshot", {})).service.registered, false);
    // A retained owned file cannot establish ownership of a different registration.
    await run("launchctl", ["bootstrap", domain, foreign]);
    await running();
    assert.equal((await job("client_platform_stop")).error, "service_not_owned");
    assert.equal((await job("client_login_set", true)).error, "service_not_owned");
    await run("launchctl", ["bootout", target]);
    assert.equal((await job("client_platform_start")).state, "completed");
    const applied = await running();
    assert.deepEqual(applied.service.login, { saved: true, applied: true });
    assert.equal(applied.configuration.pending, false);
    const content = await readFile(service.path, "utf8");
    await writeFile(service.path, content + "\n<!-- external change -->\n");
    assert.equal((await job("client_platform_stop")).error, "service_ownership_conflict");
    await writeFile(service.path, content);
    await host.close(); host = undefined;
    const retained = new ClientState(clientRoot);
    try {
      const owner = new PlatformService(retained);
      assert.equal((await owner.observe()).running, true, "closing host must not stop platform");
      await owner.stop();
      assert.equal((await owner.observe()).registered, false);
    } finally { retained.close(); }
    const rows = (await readFile(join(clientRoot, "platform", "service.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.filter(row => row.event === "started").map(row => row.ui), [null, "19031"]);
    assert.ok(rows.filter(row => row.event === "started").every(row => row.state === join(clientRoot, "platform", "state")));
  } finally {
    let released = false;
    try {
      await host?.close();
      if (target) {
        await run("launchctl", ["bootout", target]).catch(error => { if (error.code !== 3) throw error; });
        await run("launchctl", ["print", target]).then(() => { throw new Error("test service remains registered"); },
          error => { if (error.code !== 113) throw error; });
      }
      released = true;
    } finally {
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
      if (released) await rm(root, { recursive: true, force: true });
      else console.error(`Native test cleanup uncertain; disposable state retained at ${root}`);
    }
  }
});
