import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { inspectStage, sourceDateEpoch } from "../../scripts/package-deb.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function stagedRelease(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentstack-package-test-"));
  roots.push(root);
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "apps"), { recursive: true });
  await mkdir(join(root, "engines", "codex"), { recursive: true });
  await mkdir(join(root, "engines", "fx"), { recursive: true });
  await mkdir(join(root, "licenses"), { recursive: true });
  await writeFile(join(root, "runtime", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "runtime", "node"), 0o755);
  await writeFile(join(root, "apps", "cli.mjs"), "export {};\n");
  await writeFile(join(root, "apps", "daemon.mjs"), "export {};\n");
  await writeFile(
    join(root, "engines", "codex", "codex"),
    "#!/bin/sh\nexit 0\n",
  );
  await writeFile(join(root, "engines", "fx", "fx"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "engines", "codex", "codex"), 0o755);
  await chmod(join(root, "engines", "fx", "fx"), 0o755);
  await writeFile(join(root, "licenses", "NOTICE"), "fixture notice\n");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      productVersion: "0.1.0",
      buildIdentity: "test",
      target: "linux-x64",
      runtime: {
        version: "test",
        executable: "runtime/node",
        sha256: "c".repeat(64),
      },
      engines: {
        codex: {
          version: "test",
          executable: "engines/codex/codex",
          args: ["app-server"],
          sha256: "a".repeat(64),
        },
        fx: {
          version: "test",
          executable: "engines/fx/fx",
          args: ["acp"],
          sha256: "b".repeat(64),
        },
      },
    })}\n`,
  );
  return root;
}

describe("Debian package staging", () => {
  test("accepts the explicit verified-release contract", async () => {
    const stage = await stagedRelease();
    await expect(inspectStage(stage)).resolves.toMatchObject({
      stage,
      version: "0.1.0",
    });
    expect(sourceDateEpoch("0")).toBe(0);
  });

  test("rejects a staged link that would escape the release root", async () => {
    const stage = await stagedRelease();
    await symlink("/tmp", join(stage, "engines", "fx", "outside"));
    await expect(inspectStage(stage)).rejects.toThrow("escapes release root");
  });
});
