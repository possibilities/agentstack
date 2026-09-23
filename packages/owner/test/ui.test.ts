import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { uiListenPort, uiPageUrl } from "../src/ui.js";

test("package UIs render through Next.js", { timeout: 120_000 }, async () => {
  const uiModule = fileURLToPath(new URL("../src/ui.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { startUiServer } from ${JSON.stringify(uiModule)};
       const ui = await startUiServer(0);
       console.log("PORT " + ui.port);
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`ui server did not start\n${out}`)), 30_000);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
        const match = out.match(/PORT (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once("exit", () => reject(new Error(`ui server exited\n${out}`)));
    });
    const owner = await fetch(`http://127.0.0.1:${port}/_ui/owner`);
    assert.equal(owner.status, 200);
    assert.match(await owner.text(), /owner/);
    const codex = await fetch(`http://127.0.0.1:${port}/_ui/codex`);
    assert.equal(codex.status, 200);
    const api = await fetch(`http://127.0.0.1:${port}/_ui/api`);
    assert.equal(api.status, 200);
    assert.match(await api.text(), /server_start/);
    const missing = await fetch(`http://127.0.0.1:${port}/_ui/other`);
    assert.equal(missing.status, 404);
  } finally {
    child.kill("SIGKILL");
  }
});

test("the UI uses a developer port", () => {
  assert.equal(uiListenPort({}), 3000);
  assert.equal(uiListenPort({ PORT: "" }), 3000);
  assert.equal(uiListenPort({ PORT: "4321" }), 4321);
  assert.equal(uiPageUrl(3000, "owner"), "http://127.0.0.1:3000/_ui/owner");
  assert.throws(() => uiListenPort({ PORT: "nope" }), /invalid PORT: nope/);
});
