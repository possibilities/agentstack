import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexRuntimePath } from "../src/paths.js";

test("installed codexnk retains its runtime under a child-specific TMPDIR", { skip: !process.env.AGENTSTACK_TEST_REAL_CODEX }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-codexnk-runtime-"));
  const identity = join(root, "identity");
  const capabilities = join(root, "capabilities");
  const history = join(root, "history");
  const runtime = join(root, "runtime");
  await Promise.all([identity, capabilities, history, runtime].map((path) => mkdir(path, { mode: 0o700 })));
  const fakeAuth = JSON.stringify({ tokens: { refresh_token: "fixture-only" } });
  await writeFile(join(identity, "auth.json"), fakeAuth, { mode: 0o600 });
  await writeFile(join(capabilities, "SYSTEM_APPEND.md"), "Fixture append from capabilities.", { mode: 0o600 });
  await writeFile(join(capabilities, "config.toml"), '[mcp_servers.fixture]\nurl = "http://127.0.0.1:8743/mcp/fixture"\nenabled = true\n', { mode: 0o600 });
  const child = spawn(codexRuntimePath(), ["app-server", "--listen", `unix://${join(root, "app.sock")}`, "--identity", identity, "--capabilities", capabilities, "--history-dir", history], {
    env: { ...process.env, TMPDIR: runtime }, stdio: "ignore",
  });
  try {
    let home: string | null = null;
    for (let i = 0; i < 100 && !home; i += 1) {
      const children = await readdir(runtime);
      for (const name of children) {
        if ((await stat(join(runtime, name, "config.toml")).catch(() => null))?.isFile()) home = join(runtime, name);
      }
      if (!home) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(home, "codexnk should create its retained runtime inside TMPDIR");
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), fakeAuth);
    const config = await readFile(join(home, "config.toml"), "utf8");
    assert.match(config, /\[mcp_servers.fixture\]/);
    assert.match(config, /developer_instructions\s*=.*Fixture append from capabilities/);
  } finally {
    child.kill("SIGTERM");
    let force: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => { force = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000); }),
      ]);
    } finally { if (force) clearTimeout(force); }
    await rm(root, { recursive: true, force: true });
  }
});
