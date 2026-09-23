import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { uiListenPort, uiPageUrl } from "../src/ui.js";

test("package UIs render through Next.js", { timeout: 120_000 }, async () => {
  const uiModule = fileURLToPath(new URL("../src/ui.js", import.meta.url));
  const distDir = `.next/test-${randomUUID()}`;
  const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
  const tsconfigPath = join(webDir, "tsconfig.json");
  const originalTsconfig = await readFile(tsconfigPath, "utf8");
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
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTSTACK_NEXT_DIST_DIR: distDir } },
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
    assert.equal((await fetch(`http://127.0.0.1:${port}/_ui/owner?token=${encodeURIComponent("é".repeat(64))}`)).status, 401);
    const admission = await fetch(`http://127.0.0.1:${port}/_ui/owner?token=${token}`, { redirect: "manual" });
    assert.equal(admission.status, 302);
    const cookie = admission.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const authenticated = { headers: { Cookie: cookie } };
    const owner = await fetch(`http://127.0.0.1:${port}/_ui/owner`, authenticated);
    assert.equal(owner.status, 200);
    assert.match(await owner.text(), /owner/);
    const codex = await fetch(`http://127.0.0.1:${port}/_ui/codex`, authenticated);
    assert.equal(codex.status, 200);
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
