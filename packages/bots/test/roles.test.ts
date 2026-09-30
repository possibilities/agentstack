import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Supervisor, type LaunchSpec, type RunningChild } from "../src/supervisor.js";
import { internalMcpLaunches, workspaceRoot } from "@stack/api";

test("Bot launches resolve the current default and apply its internal MCP switches without changing existing snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-bot-roles-"));
  const launches: LaunchSpec[] = [];
  const internal = ["roles", "notify"];
  const supervisor = new Supervisor({ stateDir: root, graceMs: 20,
    endpoint: async () => `ws://127.0.0.1:${48000 + launches.length}`,
    mcpServers: async (botId, endpoint) => Object.fromEntries(Object.entries(await internalMcpLaunches(workspaceRoot(import.meta.dirname), { kind: "bot", botId, endpoint }, { STACK_STATE_DIR: root })).filter(([name]) => internal.includes(name))),
    waitReady: async () => undefined,
    launch(spec): RunningChild {
      launches.push(spec);
      let exit!: (code: number | null) => void;
      const exited = new Promise<number | null>((resolve) => { exit = resolve; });
      return { pid: 50000 + launches.length, exited, kill: () => exit(0) };
    },
  });
  const config = (spec: LaunchSpec) => readFile(join(spec.args[spec.args.indexOf("--capabilities") + 1]!, "config.toml"), "utf8");
  try {
    await supervisor.load();
    const account = supervisor.store.addAccount(JSON.stringify({ tokens: { refresh_token: "fixture", access_token: "fixture", id_token: "fixture.jwt.signature" } })).id;
    let catalog = supervisor.role.catalog();
    const first = catalog.defaultRoleId!;
    catalog = supervisor.role.createRole(catalog.revision, "Second");
    const second = catalog.roles.at(-1)!.id;
    const started = await supervisor.start({ id: "one", cwd: root, account });
    assert.equal(started.roleId, first);
    assert.equal(started.roleRevision, 0);
    const originalConfig = await config(launches[0]!);
    assert.match(originalConfig, /mcp_servers.roles/);
    assert.match(originalConfig, /mcp_servers.notify/);
    supervisor.role.setDefault(catalog.revision, second);
    // Both Roles are revision zero: the ID is essential to identify the applied Role.
    const next = await supervisor.start({ id: "two", cwd: root, account });
    assert.equal(next.roleId, second);
    assert.equal(next.roleRevision, 0);
    supervisor.role.role(second).setInternalMcp(0, "notify", false);
    assert.equal(await config(launches[0]!), originalConfig);
    assert.match(await config(launches[1]!), /mcp_servers.notify/);
    assert.equal((await supervisor.start({ id: "one", cwd: root })).roleId, first, "idempotent start preserves a running process");
    await supervisor.stop("one");
    const restarted = await supervisor.start({ id: "one", cwd: root });
    assert.equal(restarted.roleId, second);
    assert.equal(restarted.roleRevision, 1);
    assert.match(await config(launches[2]!), /mcp_servers.roles/);
    assert.doesNotMatch(await config(launches[2]!), /mcp_servers.notify/);
    assert.equal(supervisor.store.servers().find(({ id }) => id === "one")?.roleId, second);
    supervisor.role.role(second).setInternalMcp(1, "notify", true);
    await supervisor.stop("one");
    await supervisor.start({ id: "one", cwd: root });
    assert.match(await config(launches[3]!), /mcp_servers.notify/);
    const contents = supervisor.role.role(second);
    contents.setInternalMcp(2, "notify", false);
    contents.setInternalMcp(3, "roles", false);
    contents.createMcpServer(4, "external", "Separate tools", { type: "http", url: "https://example.test/mcp" });
    await supervisor.stop("one");
    await supervisor.start({ id: "one", cwd: root });
    const allOff = await config(launches[4]!);
    assert.doesNotMatch(allOff, /mcp_servers\.(roles|notify)/);
    assert.match(allOff, /mcp_servers.external/);
    internal.push("brain");
    await supervisor.stop("one");
    await supervisor.start({ id: "one", cwd: root });
    const addedPackage = await config(launches[5]!);
    assert.match(addedPackage, /mcp_servers.brain/);
    assert.doesNotMatch(addedPackage, /mcp_servers\.(roles|notify)/);
  } finally {
    for (const bot of supervisor.list()) if (bot.state === "running") await supervisor.stop(bot.id);
    supervisor.role.close(); supervisor.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
