import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serveApi, socketCall } from "@stack/api";

test("stack roles snapshot reads the Role from its package socket", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-roles-cli-"));
  const env = { ...process.env, STACK_STATE_DIR: state };
  let server: Awaited<ReturnType<typeof serveApi>> | undefined;
  try {
    server = await serveApi({ name: "roles", transport: "socket", env });
    await socketCall(server.socketPath!, "tools/call", { name: "role_create", arguments: { expectedRevision: 0, name: "Default" } });
    const cli = fileURLToPath(new URL("../../../cli/dist/src/main.js", import.meta.url));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "roles", "snapshot"], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
      child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
      child.once("error", reject);
      child.once("exit", code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout) as { revision: number };
    assert.equal(typeof snapshot.revision, "number");
  } finally {
    await server?.close();
    await rm(state, { recursive: true, force: true });
  }
});
