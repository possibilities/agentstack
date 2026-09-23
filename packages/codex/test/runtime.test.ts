import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installedRuntimeVersion } from "../src/runtime.js";

test("runtime version follows the installed release receipt and fails safely", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentstack-version-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(await installedRuntimeVersion(), null);
    const root = join(home, ".local/libexec/codexnk");
    const release = join(root, "release");
    await mkdir(release, { recursive: true });
    const binary = join(release, "codex");
    await writeFile(binary, "not executed", { mode: 0o755 });
    await symlink(binary, join(root, "codex"));
    const receipt = join(release, "receipt.json");
    const fields = { owner: "codexnk-release-v1", repository: "possibilities/codexnk-codex", tag: "codexnk-v0.1.1", commit: "a".repeat(40), version: "codex-cli 0.0.0" };
    assert.equal(await installedRuntimeVersion(), null);
    await writeFile(receipt, JSON.stringify(fields));
    assert.equal(await installedRuntimeVersion(), "v0.1.1");
    await writeFile(receipt, JSON.stringify({ ...fields, tag: "codexnk-v0.2.0" }));
    assert.equal(await installedRuntimeVersion(), "v0.2.0");
    for (const invalid of [null, {}, { ...fields, owner: "foreign" }, { ...fields, repository: "another/repo" }, { ...fields, tag: "codex-cli 0.0.0" }, { ...fields, commit: "unknown" }]) {
      await writeFile(receipt, JSON.stringify(invalid));
      assert.equal(await installedRuntimeVersion(), null);
    }
    await writeFile(receipt, "invalid JSON");
    assert.equal(await installedRuntimeVersion(), null);
    await writeFile(receipt, JSON.stringify(fields));
    await chmod(binary, 0o644);
    assert.equal(await installedRuntimeVersion(), null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
