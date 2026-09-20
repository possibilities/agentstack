import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  composeRemoteProgram,
  composeUpgradeMigration,
  parseArgs as parseInstallArgs,
} from "../../scripts/install-host";

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureBin = resolve(import.meta.dirname, "../fixtures/migration/bin");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function livePid(): number {
  const child = spawn("sleep", ["60"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid == null) throw new Error("live pid failed");
  return child.pid;
}

function statusPayload(options: {
  productVersion: string;
  installedVersion?: string;
  runningVersion?: string;
  buildIdentity?: string;
  daemonPid: number;
  daemonGeneration: string;
  codexPid: number;
  fxPid?: number | null;
  readiness: string;
}) {
  const children: Record<string, unknown> = {
    codex: {
      id: "codex",
      pid: options.codexPid,
      readiness: options.readiness,
      observedState: "running",
    },
  };
  const components: Array<{ id: string; pid: number }> = [
    { id: "daemon", pid: options.daemonPid },
    { id: "codex", pid: options.codexPid },
  ];
  if (options.fxPid != null) {
    children.fx = {
      id: "fx",
      pid: options.fxPid,
      readiness: "ready",
      observedState: "running",
    };
    components.push({ id: "fx", pid: options.fxPid });
  }
  return {
    schema: "agentstack.control.v1",
    control: {
      schema: "agentstack.control.v1",
      productVersion: options.productVersion,
      installedVersion: options.installedVersion ?? options.productVersion,
      runningVersion: options.runningVersion ?? options.productVersion,
      buildIdentity: options.buildIdentity ?? "git:fixture",
      daemon: {
        pid: options.daemonPid,
        generation: options.daemonGeneration,
        startedAt: "2026-09-20T00:00:00.000Z",
        desiredState: "running",
      },
      systemInventory: { schema: "agentstack.system.v1", components },
      children,
    },
  };
}

async function prepareFixture(options: {
  priorActive: boolean;
  priorEnabled?: boolean;
  oldStatus: ReturnType<typeof statusPayload>;
  newStatus: ReturnType<typeof statusPayload>;
  newVersion: string;
  stopFails?: boolean;
  seedFxState?: boolean;
  liveOldPids?: boolean;
  malformedStatus?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "agentstack-migration-"));
  roots.push(root);
  const stateDir = join(root, "fixture-state");
  const home = join(root, "home");
  const agentState = join(home, ".local", "state", "agentstack");
  const agentConfig = join(home, ".config", "agentstack");
  const pkgRoot = join(stateDir, "pkgroot");
  await mkdir(stateDir, { recursive: true });
  await mkdir(agentState, { recursive: true });
  await mkdir(agentConfig, { recursive: true });
  await mkdir(join(pkgRoot, "usr/lib/agentstack/current/engines/codex"), {
    recursive: true,
  });
  if (options.seedFxState) {
    await mkdir(join(agentState, "engines", "fx"), { recursive: true });
    await writeFile(join(agentState, "engines", "fx", "orphan.txt"), "keep\n");
  }

  let daemonPid = options.oldStatus.control.daemon.pid;
  let codexPid = (
    options.oldStatus.control.children as { codex: { pid: number } }
  ).codex.pid;
  let fxPid =
    "fx" in (options.oldStatus.control.children as object)
      ? (options.oldStatus.control.children as { fx: { pid: number } }).fx.pid
      : 333;
  if (options.liveOldPids) {
    daemonPid = livePid();
    codexPid = livePid();
    fxPid = livePid();
  }

  const patchedOld = structuredClone(options.oldStatus);
  patchedOld.control.daemon.pid = daemonPid;
  (patchedOld.control.children as { codex: { pid: number } }).codex.pid =
    codexPid;
  if ("fx" in (patchedOld.control.children as object)) {
    (patchedOld.control.children as { fx: { pid: number } }).fx.pid = fxPid;
  }

  const patchedNew = structuredClone(options.newStatus);
  patchedNew.control.daemon.pid = daemonPid + 10_000;
  (patchedNew.control.children as { codex: { pid: number } }).codex.pid =
    codexPid + 10_000;

  await writeFile(
    join(stateDir, "status.json"),
    options.malformedStatus
      ? "{not-json\n"
      : `${JSON.stringify(patchedOld)}\n`,
  );
  await writeFile(
    join(stateDir, "status.after-start.json"),
    `${JSON.stringify(patchedNew)}\n`,
  );
  await writeFile(join(stateDir, "status.exit"), "0\n");
  await writeFile(join(stateDir, "version.txt"), "AgentStack 0.1.1\n");
  await writeFile(join(stateDir, "dpkg.version"), "0.1.1\n");
  await writeFile(
    join(stateDir, "unit.active"),
    options.priorActive ? "active\n" : "inactive\n",
  );
  await writeFile(
    join(stateDir, "unit.enabled"),
    (options.priorEnabled ?? options.priorActive) ? "enabled\n" : "disabled\n",
  );
  await writeFile(
    join(stateDir, "old_pids"),
    `${daemonPid}\n${codexPid}\n${fxPid}\n`,
  );
  if (options.stopFails) await writeFile(join(stateDir, "stop.fail"), "1\n");

  const stage = join(root, "stage");
  await mkdir(stage, { recursive: true });
  const asset = `agentstack_${options.newVersion}_amd64.deb`;
  await writeFile(join(stage, asset), "fake-deb\n");

  return {
    root,
    stateDir,
    home,
    agentState,
    pkgRoot,
    stage,
    asset,
    daemonPid,
    codexPid,
    fxPid,
  };
}

function writeUpgradeScript(
  fixture: Awaited<ReturnType<typeof prepareFixture>>,
  options: {
    version: string;
    readinessAttempts?: number;
    quiesceAttempts?: number;
    expectedBuild?: string;
  },
) {
  const scriptPath = join(fixture.root, "run-upgrade.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/bash",
      "set -eu",
      `stage=${JSON.stringify(fixture.stage)}`,
      `asset=${JSON.stringify(fixture.asset)}`,
      `version=${JSON.stringify(options.version)}`,
      "prefer_enable=1",
      `expected_build=${JSON.stringify(options.expectedBuild ?? "git:fixture")}`,
      `readiness_attempts=${options.readinessAttempts ?? 10}`,
      "readiness_sleep=0.05",
      `quiesce_attempts=${options.quiesceAttempts ?? 10}`,
      "quiesce_sleep=0.05",
      composeUpgradeMigration(),
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function upgradeEnv(
  fixture: Awaited<ReturnType<typeof prepareFixture>>,
  version: string,
) {
  return {
    ...process.env,
    PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
    HOME: fixture.home,
    XDG_STATE_HOME: join(fixture.home, ".local", "state"),
    XDG_CONFIG_HOME: join(fixture.home, ".config"),
    AGENTSTACK_FIXTURE_STATE: fixture.stateDir,
    AGENTSTACK_FIXTURE_NEW_VERSION: version,
    AGENTSTACK_INSTALL_ROOT: fixture.pkgRoot,
  };
}

function runUpgradeScript(
  fixture: Awaited<ReturnType<typeof prepareFixture>>,
  options: {
    version: string;
    readinessAttempts?: number;
    quiesceAttempts?: number;
    expectedBuild?: string;
  },
) {
  const scriptPath = writeUpgradeScript(fixture, options);
  return execFileSync("bash", [scriptPath], {
    encoding: "utf8",
    timeout: 12_000,
    env: upgradeEnv(fixture, options.version),
  });
}

function runUpgradeScriptFailure(
  fixture: Awaited<ReturnType<typeof prepareFixture>>,
  options: {
    version: string;
    readinessAttempts?: number;
    quiesceAttempts?: number;
    expectedBuild?: string;
  },
) {
  const scriptPath = writeUpgradeScript(fixture, options);
  try {
    execFileSync("bash", [scriptPath], {
      encoding: "utf8",
      timeout: 12_000,
      env: upgradeEnv(fixture, options.version),
    });
    throw new Error("expected upgrade script to fail");
  } catch (error) {
    const err = error as {
      status?: number | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (err.message === "expected upgrade script to fail") throw error;
    return {
      status: err.status ?? null,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

async function expectAptNeverReached(
  fixture: Awaited<ReturnType<typeof prepareFixture>>,
) {
  await expect(readFile(join(fixture.stateDir, "apt.log"), "utf8")).rejects.toThrow();
}

function killLivePids(fixture: Awaited<ReturnType<typeof prepareFixture>>) {
  for (const pid of [fixture.daemonPid, fixture.codexPid, fixture.fxPid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

describe("install-host migration fixtures", () => {
  test("packaging scripts still pass node --check", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["--check", join(repositoryRoot, "scripts/install-host")],
        { encoding: "utf8" },
      ),
    ).not.toThrow();
  });

  test("remote program embeds fail-closed upgrade body", () => {
    const program = composeRemoteProgram({
      base: "https://github.com/owner/agentstack/releases/download/v0.1.2",
      asset: "agentstack_0.1.2_amd64.deb",
      expectedSha256: "a".repeat(64),
      tag: "v0.1.2",
      version: "0.1.2",
      enable: true,
    });
    expect(program).toContain("AGENTSTACK_STATUS_JSON");
    expect(program).not.toContain("json.load(sys.stdin)");
    expect(program).not.toMatch(/agentstack stop \|\| true/);
    expect(program).toContain("refused to replace package");
    expect(program).toContain(".agentstack-upgrade-marker");
    expect(program).toContain("codex readiness not ready");
    expect(program).toContain("buildIdentity");
    expect(program).toContain("quiesce_attempts=");
    expect(program).toContain("readiness_attempts=");
    expect(program).toMatch(/source\.revision is required|source\.revision/);
    expect(program).toContain("need_quiesce");
    expect(program).toContain("inode_of");
    expect(program).not.toContain("stat -c");
    expect(program).toContain("git:?*");
    expect(
      parseInstallArgs([
        "--remote",
        "debian-host",
        "--repository",
        "owner/agentstack",
        "--tag",
        "v0.1.2",
        "--expected-sha256",
        "a".repeat(64),
      ]),
    ).toMatchObject({ remote: "debian-host", tag: "v0.1.2" });
  });

  test("happy path: stop, replace, new identity, ready, preserve fx state", async () => {
    const fixture = await prepareFixture({
      priorActive: true,
      priorEnabled: true,
      newVersion: "0.1.2",
      seedFxState: true,
      liveOldPids: false,
      oldStatus: statusPayload({
        productVersion: "0.1.1",
        daemonPid: 111001,
        daemonGeneration: "gen-old",
        codexPid: 111002,
        fxPid: 111003,
        readiness: "ready",
      }),
      newStatus: statusPayload({
        productVersion: "0.1.2",
        daemonPid: 222001,
        daemonGeneration: "gen-new",
        codexPid: 222002,
        readiness: "ready",
      }),
    });

    const stdout = runUpgradeScript(fixture, { version: "0.1.2" });
    expect(stdout).toContain("upgrade to 0.1.2 complete");
    expect(await readFile(join(fixture.stateDir, "apt.log"), "utf8")).toContain(
      "apt-get",
    );
    expect(await readFile(join(fixture.stateDir, "stop.log"), "utf8")).toContain(
      "stopped",
    );
    expect(
      await readFile(
        join(fixture.agentState, "engines", "fx", "orphan.txt"),
        "utf8",
      ),
    ).toBe("keep\n");
  });

  test("fail-closed: refuses package replace when stop fails and PIDs live", async () => {
    const fixture = await prepareFixture({
      priorActive: true,
      newVersion: "0.1.2",
      stopFails: true,
      liveOldPids: true,
      oldStatus: statusPayload({
        productVersion: "0.1.1",
        daemonPid: 1,
        daemonGeneration: "gen-old",
        codexPid: 2,
        fxPid: 3,
        readiness: "ready",
      }),
      newStatus: statusPayload({
        productVersion: "0.1.2",
        daemonPid: 100,
        daemonGeneration: "gen-new",
        codexPid: 101,
        readiness: "ready",
      }),
    });

    const failure = runUpgradeScriptFailure(fixture, {
      version: "0.1.2",
      readinessAttempts: 3,
      quiesceAttempts: 3,
    });
    expect(failure.stderr).toMatch(
      /fixture: stop failed|refused to replace package|process still running/,
    );
    expect(failure.stderr).not.toMatch(/fixture sudo/);
    await expectAptNeverReached(fixture);
    killLivePids(fixture);
  });

  test("rejects unknown readiness and OR-only version matches", async () => {
    const fixture = await prepareFixture({
      priorActive: true,
      newVersion: "0.1.2",
      liveOldPids: false,
      oldStatus: statusPayload({
        productVersion: "0.1.1",
        daemonPid: 111001,
        daemonGeneration: "gen-old",
        codexPid: 111002,
        fxPid: 111003,
        readiness: "ready",
      }),
      newStatus: statusPayload({
        productVersion: "0.1.2",
        installedVersion: "0.1.1",
        runningVersion: "0.1.2",
        daemonPid: 222001,
        daemonGeneration: "gen-new",
        codexPid: 222002,
        readiness: "unknown",
      }),
    });

    const failure = runUpgradeScriptFailure(fixture, {
      version: "0.1.2",
      readinessAttempts: 3,
      quiesceAttempts: 5,
    });
    expect(failure.stderr).toMatch(
      /bounded readiness poll failed|version mismatch|codex readiness not ready|readiness not ready/,
    );
  });

  test("fail-closed: live old PIDs refuse replace when unit reports inactive", async () => {
    const fixture = await prepareFixture({
      priorActive: false,
      priorEnabled: false,
      newVersion: "0.1.2",
      stopFails: true,
      liveOldPids: true,
      oldStatus: statusPayload({
        productVersion: "0.1.1",
        daemonPid: 1,
        daemonGeneration: "gen-old",
        codexPid: 2,
        fxPid: 3,
        readiness: "ready",
      }),
      newStatus: statusPayload({
        productVersion: "0.1.2",
        daemonPid: 100,
        daemonGeneration: "gen-new",
        codexPid: 101,
        readiness: "ready",
      }),
    });

    const failure = runUpgradeScriptFailure(fixture, {
      version: "0.1.2",
      readinessAttempts: 3,
      quiesceAttempts: 3,
    });
    expect(failure.stderr).toMatch(
      /fixture: stop failed|refused to replace package|process still running/,
    );
    expect(failure.stderr).not.toMatch(/fixture sudo/);
    expect(failure.stderr).not.toMatch(/stat:|illegal option|invalid option/);
    await expectAptNeverReached(fixture);
    killLivePids(fixture);
  });


  test("missing expected build identity refuses before apt", async () => {
    const fixture = await prepareFixture({
      priorActive: true,
      newVersion: "0.1.2",
      liveOldPids: false,
      oldStatus: statusPayload({
        productVersion: "0.1.1",
        daemonPid: 111001,
        daemonGeneration: "gen-old",
        codexPid: 111002,
        fxPid: 111003,
        readiness: "ready",
      }),
      newStatus: statusPayload({
        productVersion: "0.1.2",
        buildIdentity: "git:wrong",
        daemonPid: 222001,
        daemonGeneration: "gen-new",
        codexPid: 222002,
        readiness: "ready",
      }),
    });

    const failure = runUpgradeScriptFailure(fixture, {
      version: "0.1.2",
      expectedBuild: "",
      readinessAttempts: 3,
      quiesceAttempts: 3,
    });
    expect(failure.stderr).toMatch(/source\.revision|build identity/);
    expect(failure.stderr).not.toMatch(/stat:|illegal option|invalid option/);
    await expectAptNeverReached(fixture);
  });

  test("malformed prior status refuses before apt", async () => {
    const fixture = await prepareFixture({
      priorActive: true,
      newVersion: "0.1.2",
      liveOldPids: false,
      malformedStatus: true,
      oldStatus: statusPayload({
        productVersion: "0.1.1",
        daemonPid: 111001,
        daemonGeneration: "gen-old",
        codexPid: 111002,
        fxPid: 111003,
        readiness: "ready",
      }),
      newStatus: statusPayload({
        productVersion: "0.1.2",
        daemonPid: 222001,
        daemonGeneration: "gen-new",
        codexPid: 222002,
        readiness: "ready",
      }),
    });

    const failure = runUpgradeScriptFailure(fixture, {
      version: "0.1.2",
      readinessAttempts: 3,
      quiesceAttempts: 3,
    });
    expect(failure.stderr).toMatch(
      /malformed or unknown|unparseable|status control/,
    );
    expect(failure.stderr).not.toMatch(/stat:|illegal option|invalid option/);
    await expectAptNeverReached(fixture);
  });
});
