import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall } from "@agentstack/api";
import { installedRuntimeVersion, StateStore } from "@agentstack/codex";
import { uiListenPort, uiPageUrl } from "../src/ui.js";

const fakeBin = fileURLToPath(new URL("../../../codex/test/fixtures/fake-app-server.mjs", import.meta.url));

test("package UIs render through Next.js", { timeout: 120_000 }, async () => {
  const uiModule = fileURLToPath(new URL("../src/ui.js", import.meta.url));
  const distDir = `.next/test-${randomUUID()}`;
  const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
  const tsconfigPath = join(webDir, "tsconfig.json");
  const originalTsconfig = await readFile(tsconfigPath, "utf8");
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-ui-state-"));
  const home = await mkdtemp(join(tmpdir(), "agentstack-ui-home-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const runtime = join(home, ".local", "libexec", "codexnk", "codex");
  await mkdir(join(runtime, ".."), { recursive: true });
  await symlink(fakeBin, runtime);
  const store = new StateStore(stateDir);
  store.addAccount(JSON.stringify({ tokens: { refresh_token: "test-refresh", access_token: "access", id_token: "fixture.jwt.signature" } }));
  store.close();
  const apiEnv = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const codex = await serveApi({ name: "codex", transport: "socket", env: apiEnv });
  const bots = await serveApi({ name: "bots", transport: "socket", env: apiEnv });
  await socketCall(bots.socketPath ?? "", "tools/call", { name: "bot_start", arguments: {} });
  await socketCall(codex.socketPath ?? "", "tools/call", { name: "server_start", arguments: { id: "notabot", cwd: webDir } });
  const pendingLogin = (await socketCall(codex.socketPath ?? "", "tools/call", {
    name: "account_login_start",
    arguments: {},
  })) as { id: string };
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { startUiServer } from ${JSON.stringify(uiModule)};
       const ui = await startUiServer(0);
       console.log("PORT " + ui.port + " TOKEN " + ui.token);
       setInterval(() => {}, 1000);`,
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, AGENTSTACK_NEXT_DIST_DIR: distDir, AGENTSTACK_STATE_DIR: stateDir },
    },
  );
  try {
    const session = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => finish(new Error(`ui server did not start\n${out}`)), 30_000);
      let settled = false;
      const finish = (value: { port: number; token: string } | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
        const match = out.match(/PORT (\d+) TOKEN ([0-9a-f]+)/);
        if (match) finish({ port: Number(match[1]), token: match[2] });
      });
      child.once("exit", () => finish(new Error(`ui server exited\n${out}`)));
    });
    const { port, token } = session;
    assert.equal((await fetch(`http://127.0.0.1:${port}/_ui/owner`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/_ui/codex/auth`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/_ui/owner?token=${encodeURIComponent("é".repeat(64))}`)).status, 401);
    const nestedAdmission = await fetch(`http://127.0.0.1:${port}/_ui/codex/auth?token=${token}`, { redirect: "manual" });
    assert.equal(nestedAdmission.status, 302);
    assert.equal(nestedAdmission.headers.get("location"), "/_ui/codex/auth");
    const admission = await fetch(`http://127.0.0.1:${port}/_ui/owner?token=${token}`, { redirect: "manual" });
    assert.equal(admission.status, 302);
    const cookie = admission.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const authenticated = { headers: { Cookie: cookie } };
    const owner = await fetch(`http://127.0.0.1:${port}/_ui/owner`, authenticated);
    assert.equal(owner.status, 200);
    assert.match(await owner.text(), /owner/);
    const codexResponse = await fetch(`http://127.0.0.1:${port}/_ui/codex`, authenticated);
    assert.equal(codexResponse.status, 200);
    const expectedVersion = await installedRuntimeVersion();
    const codexHtml = await codexResponse.text();
    assert.ok(codexHtml.includes(`Installed runtime: codexnk ${expectedVersion ?? "version unavailable"}`));
    assert.ok(codexHtml.includes(`codexnk ${expectedVersion ?? "version unavailable"}`));
    assert.ok(codexHtml.includes('href="/_ui/codex"'));
    assert.ok(codexHtml.includes('href="/_ui/codex/auth"'));
    assert.match(codexHtml, /<a[^>]*aria-current="page"[^>]*>Servers</);
    assert.equal(codexHtml.match(/aria-current="page"/g)?.length, 1);
    assert.ok(codexHtml.includes("Running servers"));
    assert.ok(codexHtml.includes("notabot"));
    assert.ok(!codexHtml.includes("Add account"));
    assert.ok(!codexHtml.includes('aria-label="Codex accounts"'));
    assert.ok(!codexHtml.includes("ABCD-EFGH"));
    assert.ok(!codexHtml.includes("Copy code"));
    let currentLogin: { login: { id: string; authUrl: string | null } | null } = { login: null };
    for (let i = 0; i < 100 && !(currentLogin.login?.id === pendingLogin.id && currentLogin.login.authUrl); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      currentLogin = (await socketCall(codex.socketPath ?? "", "tools/call", {
        name: "account_login_current",
        arguments: {},
      })) as { login: { id: string; authUrl: string | null } | null };
    }
    assert.equal(currentLogin.login?.authUrl, "https://auth.openai.com/codex/device");
    const authResponse = await fetch(`http://127.0.0.1:${port}/_ui/codex/auth`, authenticated);
    assert.equal(authResponse.status, 200);
    const authHtml = await authResponse.text();
    assert.ok(authHtml.includes('href="/_ui/codex"'));
    assert.ok(authHtml.includes('href="/_ui/codex/auth"'));
    assert.match(authHtml, /<a[^>]*aria-current="page"[^>]*>Auth</);
    assert.equal(authHtml.match(/aria-current="page"/g)?.length, 1);
    assert.ok(authHtml.includes("Add account"));
    assert.ok(authHtml.includes("codex-1"));
    assert.ok(authHtml.includes("https://auth.openai.com/codex/device"));
    assert.ok(authHtml.includes("ABCD-EFGH"));
    assert.ok(authHtml.includes("Copy URL"));
    assert.ok(authHtml.includes("Copy code"));
    assert.ok(authHtml.includes("Cancel sign-in"));
    assert.ok(authHtml.includes("Start over"));
    assert.ok(!authHtml.includes("Running servers"));
    assert.ok(!authHtml.includes("notabot"));
    await socketCall(codex.socketPath ?? "", "tools/call", {
      name: "account_login_cancel",
      arguments: { id: pendingLogin.id },
    });
    const botsResponse = await fetch(`http://127.0.0.1:${port}/_ui/bots`, authenticated);
    assert.equal(botsResponse.status, 200);
    const botsHtml = await botsResponse.text();
    assert.match(botsHtml, /Bots/);
    assert.ok(botsHtml.includes("bot-1"));
    assert.ok(!botsHtml.includes("notabot"));
    const api = await fetch(`http://127.0.0.1:${port}/_ui/api`, authenticated);
    assert.equal(api.status, 200);
    assert.match(await api.text(), /server_start/);
    const missing = await fetch(`http://127.0.0.1:${port}/_ui/other`, authenticated);
    assert.equal(missing.status, 404);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/_ui/codex", headers: { Host: `attacker.example:${port}`, Cookie: cookie } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(reboundStatus, 421);
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await bots.close();
    await codex.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(stateDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(join(webDir, distDir), { recursive: true, force: true });
    await writeFile(tsconfigPath, originalTsconfig);
  }
});

test("the UI uses a developer port", () => {
  assert.equal(uiListenPort({}), 3000);
  assert.equal(uiListenPort({ PORT: "" }), 3000);
  assert.equal(uiListenPort({ PORT: "4321" }), 4321);
  assert.equal(uiPageUrl(3000, "owner"), "http://127.0.0.1:3000/_ui/owner");
  assert.equal(uiPageUrl(3000, "owner", "secret"), "http://127.0.0.1:3000/_ui/owner?token=secret");
  assert.throws(() => uiListenPort({ PORT: "nope" }), /invalid PORT: nope/);
});
