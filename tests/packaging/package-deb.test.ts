import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  inspectStage,
  sourceDateEpoch,
  validateManifest,
} from "../../scripts/package-deb.mjs";
import { normalizedEntries } from "../../scripts/inspect-deb.mjs";
import {
  composeRemoteProgram,
  parseArgs as parseInstallArgs,
} from "../../scripts/install-host";

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../..");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function stagedRelease(productVersion = "0.1.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentstack-package-test-"));
  roots.push(root);
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "apps"), { recursive: true });
  await mkdir(join(root, "engines", "codex"), { recursive: true });
  await mkdir(join(root, "licenses"), { recursive: true });
  await writeFile(join(root, "runtime", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "runtime", "node"), 0o755);
  await writeFile(join(root, "apps", "cli.mjs"), "export {};\n");
  await writeFile(join(root, "apps", "daemon.mjs"), "export {};\n");
  await writeFile(
    join(root, "engines", "codex", "codex"),
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(join(root, "engines", "codex", "codex"), 0o755);
  await writeFile(join(root, "licenses", "NOTICE"), "fixture notice\n");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      productVersion,
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
      },
    })}\n`,
  );
  return root;
}

describe("Debian package staging", () => {
  test("packaging scripts pass node --check", () => {
    for (const script of [
      "scripts/stage-release.mjs",
      "scripts/package-deb.mjs",
      "scripts/verify-payload.mjs",
      "scripts/inspect-deb.mjs",
      "scripts/install-host",
      "scripts/create-release-manifest.mjs",
    ]) {
      expect(() =>
        execFileSync(process.execPath, ["--check", join(repositoryRoot, script)], {
          encoding: "utf8",
        }),
      ).not.toThrow();
    }
  });

  test("parses the dpkg-deb root entry", () => {
    expect(
      normalizedEntries(
        Buffer.from("drwxr-xr-x root/root 0 2026-09-20 20:12 ./\n"),
      ),
    ).toEqual([{ path: "/", linkTarget: null }]);
  });

  test("requires an exact public release identity for host installation", () => {
    expect(
      parseInstallArgs([
        "--remote",
        "debian-host",
        "--repository",
        "owner/agentstack",
        "--tag",
        "v0.1.0",
        "--expected-sha256",
        "a".repeat(64),
      ]),
    ).toMatchObject({
      remote: "debian-host",
      repository: "owner/agentstack",
      tag: "v0.1.0",
      expected_sha256: "a".repeat(64),
    });
  });

  test("host install remote program stops before replace and verifies Codex-only", () => {
    const program = composeRemoteProgram({
      base: "https://github.com/owner/agentstack/releases/download/v0.1.2",
      asset: "agentstack_0.1.2_amd64.deb",
      expectedSha256: "a".repeat(64),
      tag: "v0.1.2",
      version: "0.1.2",
      enable: true,
    });
    expect(program).toContain("prior_active=");
    expect(program).toContain("prior_enabled=");
    expect(program).toContain("old_fx_pid");
    expect(program).toContain("AGENTSTACK_STATUS_JSON");
    expect(program).not.toContain("json.load(sys.stdin)");
    expect(program).toMatch(/agentstack stop|systemctl --user stop/);
    expect(program).not.toMatch(/agentstack stop \|\| true/);
    expect(program).toContain('sudo -n apt-get install -y "$stage/$asset"');
    expect(program.indexOf("agentstack stop")).toBeLessThan(
      program.indexOf('sudo -n apt-get install -y "$stage/$asset"'),
    );
    expect(program).toContain("agentstack enable --now");
    expect(program).toContain('test "$installed" = "$version"');
    expect(program).toContain("AGENTSTACK_INSTALL_ROOT");
    expect(program).toContain("agentstack-upgrade-marker");
    expect(program).toContain('readiness != "ready"');
    expect(program).toContain("refused to replace package");
    expect(program).toContain("new identity verified");
    expect(program).toContain("Preserve all user state");
  });

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
    await symlink("/tmp", join(stage, "engines", "codex", "outside"));
    await expect(inspectStage(stage)).rejects.toThrow("escapes release root");
  });

  test("accepts distinct N and N+1 immutable release versions", async () => {
    const current = await stagedRelease("0.1.1");
    const next = await stagedRelease("0.1.2");
    await expect(inspectStage(current, "0.1.1")).resolves.toMatchObject({
      version: "0.1.1",
    });
    await expect(inspectStage(next, "0.1.2")).resolves.toMatchObject({
      version: "0.1.2",
    });
  });

  test("rejects retired Fx manifest keys, paths, licenses, and provenance", async () => {
    expect(() =>
      validateManifest({
        productVersion: "0.1.2",
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
            args: [],
            sha256: "b".repeat(64),
          },
        },
      }),
    ).toThrow(/engines\.fx|only codex/);

    const withFxDir = await stagedRelease("0.1.2");
    await mkdir(join(withFxDir, "engines", "fx"), { recursive: true });
    await writeFile(join(withFxDir, "engines", "fx", "fx"), "#!/bin/sh\n");
    await expect(inspectStage(withFxDir)).rejects.toThrow(/retired Fx/);

    const withFxLicense = await stagedRelease("0.1.2");
    await writeFile(join(withFxLicense, "licenses", "fx-LICENSE.txt"), "fx\n");
    await expect(inspectStage(withFxLicense)).rejects.toThrow(/retired Fx/);

    const withFxProvenance = await stagedRelease("0.1.2");
    await mkdir(join(withFxProvenance, "provenance"), { recursive: true });
    await writeFile(
      join(withFxProvenance, "provenance", "vendor-manifest.json"),
      `${JSON.stringify({ components: { fx: { version: "retired" } } })}\n`,
    );
    await expect(inspectStage(withFxProvenance)).rejects.toThrow(/retired fx/);
  });
});
