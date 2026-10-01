import assert from "node:assert/strict";
import test from "node:test";
import { serveHttp } from "../src/http.js";
import { get } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installationControlRoot } from "../src/installation-fence.js";

function request(url: string, host: string): Promise<{ status: number | undefined; cookies: string[] | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { host } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, cookies: response.headers["set-cookie"], text }));
    }).on("error", reject);
  });
}

test("loopback HTTP rejects rebound Hosts before dispatch and preserves separate cookies", async () => {
  let calls = 0;
  const served = await serveHttp({ host: "127.0.0.1", port: 0, handle() {
    calls++;
    const headers = new Headers();
    headers.append("set-cookie", "first=1; HttpOnly");
    headers.append("set-cookie", "second=2; HttpOnly");
    return new Response("private", { headers });
  } });
  const url = `http://127.0.0.1:${served.port}/`;
  try {
    for (const host of ["rebind.example", `rebind.example:${served.port}`, "127.0.0.1:1"]) {
      assert.equal((await request(url, host)).status, 403);
    }
    assert.equal(calls, 0);
    for (const host of [`127.0.0.1:${served.port}`, `localhost:${served.port}`]) {
      const response = await request(url, host);
      assert.equal(response.text, "private");
      assert.deepEqual(response.cookies, ["first=1; HttpOnly", "second=2; HttpOnly"]);
    }
    assert.equal(calls, 2);
  } finally { await served.close(); }
});
test("installation reset fences existing owner HTTP requests and new listeners before content admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-http-fence-")), env = { STACK_STATE_DIR: root }, control = installationControlRoot(env);
  let admissions = 0;
  const served = await serveHttp({ env, host: "127.0.0.1", port: 0, handle() { admissions++; return new Response("admitted"); } });
  try {
    assert.equal((await request(`http://127.0.0.1:${served.port}/`, `127.0.0.1:${served.port}`)).status, 200);
    await mkdir(control, { mode: 0o700 });
    await writeFile(join(control, "fence.json"), JSON.stringify({ version: 1, requestId: randomUUID(), generation: randomUUID(), nextGeneration: randomUUID(), pid: process.pid, browserRevision: "empty" }), { mode: 0o600 });
    assert.equal((await request(`http://127.0.0.1:${served.port}/`, `127.0.0.1:${served.port}`)).status, 500);
    assert.equal(admissions, 1, "HTTP cannot bypass the fence while the parent drains sockets");
    await assert.rejects(serveHttp({ env, host: "127.0.0.1", port: 0, handle() { admissions++; return new Response(); } }), /factory reset is fenced/);
    assert.equal(admissions, 1);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); await rm(control, { recursive: true, force: true }); }
});
