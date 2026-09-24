import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownerMcpUrls } from "../src/owner-mcp.js";

test("Server MCP URLs follow the owner's current configured Package APIs and bound port", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-owner-mcp-"));
  try {
    const alpha = join(root, "packages", "alpha");
    const beta = join(root, "packages", "beta");
    await mkdir(alpha, { recursive: true });
    await mkdir(beta);
    await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n");
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nsocket:\n  description: Beta socket.\n");
    assert.deepEqual(await ownerMcpUrls(root, 43123), { alpha: "http://127.0.0.1:43123/mcp/alpha" });
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n");
    assert.deepEqual(await ownerMcpUrls(root, 43123), {
      alpha: "http://127.0.0.1:43123/mcp/alpha",
      beta: "http://127.0.0.1:43123/mcp/beta",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
