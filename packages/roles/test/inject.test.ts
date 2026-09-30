import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { z } from "zod";
import { configuredMcpServers, workspaceRoot, operation, operatorHeaders, serveApi, serveSocket, socketCall, socketPath, socketSubscribe } from "@stack/api";
import { startOpenCodeHost } from "../src/inject-opencode.js";

const cli = fileURLToPath(new URL("../../../cli/dist/src/main.js", import.meta.url));
const instructions = "  Role instructions — verbatim.\n\nSecond paragraph.  ";

// A native-boundary fixture records what the actual CLI launched, including
// file bytes. Native support for the switches is separately smoke-tested against
// the installed harnesses; this fixture is not that evidence.
const fixture = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const harness = path.basename(process.argv[1]);
if (argv.length === 1 && argv[0] === '--help') {
 console.log('--setting-sources --strict-mcp-config --plugin-dir --append-system-prompt --system-prompt-snapshot --no-daemon'); process.exit(0);
}
if (argv.length === 1 && argv[0] === '--version') { console.log(process.env.FIXTURE_VERSION || '2.0.16'); process.exit(0); }
const read = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
const option = name => argv[argv.indexOf(name) + 1];
const all = dir => !fs.existsSync(dir) ? {} : Object.fromEntries(fs.readdirSync(dir, {recursive: true, withFileTypes: true}).filter(x=>x.isFile()).map(x=>[path.relative(dir,path.join(x.parentPath,x.name)),read(path.join(x.parentPath,x.name))]));
let report = { harness, argv, home: process.env.HOME, ambient: read(path.join(process.env.HOME, 'ambient')), config: null };
if (harness === 'claude' && argv.includes('--setting-sources')) {
 report.config = JSON.parse(read(option('--mcp-config'))); report.skills = all(path.join(option('--plugin-dir'), 'skills'));
 report.instructions = read(option('--append-system-prompt-file')); report.root = path.dirname(path.dirname(option('--mcp-config')));
 report.memory = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
} else if (harness === 'codex' && process.env.CODEX_HOME) {
 report.config = read(path.join(process.env.CODEX_HOME,'config.toml')); report.skills = all(path.join(process.env.CODEX_HOME,'skills'));
 report.authLink = fs.existsSync(path.join(process.env.CODEX_HOME,'auth.json')) ? fs.readlinkSync(path.join(process.env.CODEX_HOME,'auth.json')) : null;
 report.root = path.dirname(path.dirname(process.env.CODEX_HOME));
 fs.writeFileSync(path.join(process.env.CODEX_HOME,'session-fixture'),'history');
} else if (harness === 'opencode' && process.env.OPENCODE_CONFIG_DIR) {
 report.config = JSON.parse(read(path.join(process.env.OPENCODE_CONFIG_DIR,'opencode.json')));
 report.skills = all(report.config.skills[0]); report.plugin = read(path.join(report.config.plugins.at(-1),'index.ts'));
 report.root = path.dirname(path.dirname(process.env.OPENCODE_CONFIG_DIR));
  report.env = {project:process.env.OPENCODE_CONFIG_PROJECT_DISABLE, file:process.env.OPENCODE_CONFIG, inline:process.env.OPENCODE_CONFIG_CONTENT, cli:process.env.OPENCODE_CLI_CONFIG_CONTENT, db:process.env.OPENCODE_DB};
 report.listener=option('--server');
 fs.mkdirSync(process.env.XDG_DATA_HOME,{recursive:true}); fs.writeFileSync(path.join(process.env.XDG_DATA_HOME,'session-fixture'),'history');
}
if (process.env.FIXTURE_WAIT) {
 fs.writeFileSync(process.env.FIXTURE_WAIT, JSON.stringify(report));
 setInterval(()=>{},1000);
} else {
 let input=''; process.stdin.setEncoding('utf8').on('data',x=>input+=x).on('end',async()=>{
  report.input=input;
  if (harness === 'opencode' && argv.includes('--server')) {
   report.listener=option('--server');
   report.unauthorized=(await fetch(report.listener+'/api/config')).status;
   const response=await fetch(report.listener+'/api/config',{headers:{Authorization:'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64')}});
   report.nativeConfig=await response.json();
   if (process.env.FIXTURE_AUTH) {
    const headers={Authorization:'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64'),'Content-Type':'application/json'};
    for(let attempt=0;attempt<100;attempt++) {
     report.nativeSkills=(await (await fetch(report.listener+'/api/skill',{headers})).json()).data;
     report.integration=(await (await fetch(report.listener+'/api/integration/openai',{headers})).json()).data;
     if(report.integration && report.nativeSkills?.some(skill=>skill.id==='role-skill')) break;
     await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!report.integration) throw new Error('native integration fixture did not become ready');
    const connection=report.integration.connections.find(item=>item.id===process.env.FIXTURE_AUTH);
    if (!connection) throw new Error('ordinary native credential is missing');
    report.credentialUpdate=(await fetch(report.listener+'/api/credential/'+connection.id,{method:'PATCH',headers,body:JSON.stringify({label:'Updated through native API'})})).status;
   }
   const plugin=await import('data:text/javascript;base64,'+Buffer.from(report.plugin).toString('base64'));
   const event={system:[]}; let disposed=false;
   const cleanup=await plugin.default.setup({session:{hook:async(name,fn)=>{if(name!=='context')throw new Error('wrong hook');fn(event);return{dispose(){disposed=true}}}}});
   await cleanup(); report.instructions=event.system[0].text; report.disposed=disposed;
  }
  console.log(JSON.stringify(report)); process.exit(Number(process.env.FIXTURE_EXIT || 0));
 });
}
`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ri-"));
  const home = join(root, "home"), bin = join(root, "bin"), state = join(root, "s");
  await mkdir(home); await mkdir(bin);
  await writeFile(join(home, "ambient"), "ordinary home untouched");
  for (const harness of ["claude", "codex", "opencode"]) { await writeFile(join(bin, harness), fixture); await chmod(join(bin, harness), 0o700); }
  const env = { ...process.env, HOME: home, STACK_STATE_DIR: state, STACK_INSTALL_BIN_DIR: bin, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_TEST_HOME: home, OPENCODE_DB: join(home, "ordinary.db"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_CONFIG: join(home, "ambient.json"), OPENCODE_CONFIG_CONTENT: '{"plugins":["ambient"]}', OPENCODE_CLI_CONFIG_CONTENT: '{"plugins":["ambient"]}',
    STACK_CODEX_TOOLS_BIN: join(root, "no-desktop-runtime"),
    ROLE_TEST_TOKEN: "private-fixture-token", ROLE_TEST_HEADER: "private-fixture-header", ROLE_TEST_ENV: "private-fixture-env" };
  await mkdir(env.CODEX_HOME); await writeFile(join(env.CODEX_HOME, "auth.json"), '{"fixture":"never-real-auth"}');
  const roles = await serveApi({ name: "roles", transport: "socket", env });
  const mcpUrls: Record<string, string> = { roles: "http://127.0.0.1:48743/mcp/roles", notify: "http://127.0.0.1:48743/mcp/notify" };
  const serve = await serveSocket({ info: { name: "serve", description: "fixture", transportDescription: "fixture", path: socketPath("serve", env) }, context: {}, operations: [operation({
    name: "serve_status", description: "Fixture listener inventory", input: z.object({}), output: z.object({ mcpUrls: z.record(z.string(), z.string()) }),
    async call() { return { mcpUrls }; },
  })] });
  const call = (name: string, args: Record<string, unknown> = {}) => socketCall(roles.socketPath!, "tools/call", { name, arguments: args }) as Promise<any>;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, direct?: string) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = direct ? spawn(join(bin, direct), args, { env: { ...env, ...extra }, cwd: home })
      : spawn(process.execPath, [cli, "roles", ...args], { env: { ...env, ...extra }, cwd: home });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end("piped input\n");
  });
  return { root, home, bin, state, env, call, run, mcpUrls, close: async () => { await serve.close(); await roles.close(); await rm(root, { recursive: true, force: true }); } };
}

async function populate(f: Awaited<ReturnType<typeof setup>>) {
  const initial = await f.call("roles_snapshot");
  const catalog = await f.call("role_create", { expectedRevision: initial.revision, name: "Research É" });
  const roleId = catalog.roles.at(-1).id;
  await f.call("category_create", { roleId, expectedRevision: 0, title: "Human-only category" });
  const snapshot = await f.call("role_snapshot", { roleId });
  let revision = 1;
  const write = async (name: string, fields: Record<string, unknown>) => f.call(name, { roleId, expectedRevision: revision++, ...fields });
  await write("fragment_create", { categoryId: snapshot.categories[0].id, title: "Human-only title", body: instructions });
  await write("fragment_create", { categoryId: snapshot.categories[0].id, title: "Disabled", body: "DO NOT INJECT", enabled: false });
  await write("skill_create", { name: "role-skill", description: "Role skill description", body: "Role skill body", files: [{ path: "assets/bytes.txt", contentBase64: Buffer.from("support\0bytes").toString("base64") }] });
  await write("skill_create", { name: "disabled-skill", description: "Disabled", body: "DO NOT INJECT", enabled: false });
  await write("mcp_server_create", { name: "external", description: "", definition: { type: "http", url: "http://127.0.0.1:9/mcp", bearerTokenEnvVar: "ROLE_TEST_TOKEN", envHttpHeaders: { "X-Test": "ROLE_TEST_HEADER" } } });
  await write("mcp_server_create", { name: "stdio", description: "", definition: { type: "stdio", command: process.execPath, args: ["--version", "one argument"], envVars: ["ROLE_TEST_ENV"] } });
  await write("mcp_server_create", { name: "disabled-mcp", description: "", enabled: false, definition: { type: "http", url: "http://127.0.0.1:9/disabled" } });
  await write("role_internal_mcp_update", { name: "notify", enabled: false });
  return roleId;
}

test("inject launches each native boundary with the selected bytes, private credentials, argv and stdio; ordinary launch stays unchanged", async () => {
  const f = await setup();
  try {
    const roleId = await populate(f);
    const names = [...(await configuredMcpServers(workspaceRoot(import.meta.dirname))).map(item => item.name).filter(name => name !== "notify"), "external", "stdio"].sort();
    const snapshot = await f.call("role_snapshot", { roleId });
    await f.call("fragment_update", { roleId, expectedRevision: snapshot.revision, id: snapshot.categories[0].fragments[0].id,
      conditions: { model: "render-only-model", harness: "render-only-harness" } });
    await f.call("fragment_create", { roleId, expectedRevision: snapshot.revision + 1, categoryId: snapshot.categories[0].id,
      title: "Nonmatching", body: "DO NOT INJECT", conditions: { model: "other" } });
    for (const harness of ["claude", "codex", "opencode"]) {
      const ordinaryBefore = await f.run(["--", "ordinary prompt"], { CODEX_HOME: undefined, OPENCODE_CONFIG_DIR: undefined }, harness);
      const native = harness === "opencode" ? ["run", "-mtest/model#high", "--auto", "--format=json", "--", "--settings", "two words"]
        : harness === "codex" ? ["exec", "--model", "test/model", '-cmodel_reasoning_effort="high"', "--sandbox", "read-only", "--json", "--", "--settings", "two words"]
        : ["--model", "test/model", "--effort", "high", "--permission-mode", "plan", "--allowed-tools", "Read", "--output-format", "json", "--max-turns", "2", "--debug", "--", "--settings", "two words"];
      const result = await f.run(["inject", "--with-model", "render-only-model", "rESEARCH É", "--with-harness=render-only-harness", "--", harness, ...native], { FIXTURE_EXIT: "7" });
      assert.equal(result.code, 7, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.ok(!report.argv.some((arg: string) => /with-model|with-harness|render-only/.test(arg)));
      assert.deepEqual(harness === "opencode" ? [report.argv[0], ...report.argv.slice(3)] : report.argv.slice(-native.length), native);
      assert.equal(report.input, "piped input\n");
      assert.deepEqual(Object.keys(report.skills).sort(), ["role-skill/SKILL.md", "role-skill/assets/bytes.txt"]);
      assert.equal(report.skills["role-skill/assets/bytes.txt"], "support\0bytes");
      assert.match(report.skills["role-skill/SKILL.md"], /Role skill body/);
      if (harness === "claude") {
        assert.equal(report.instructions, instructions);
        assert.equal(report.memory, "1");
        assert.equal(report.argv[report.argv.indexOf("--setting-sources") + 1], "");
        assert.equal(report.config.mcpServers.roles.type, "stdio");
        assert.equal(report.config.mcpServers.roles.command, process.execPath);
        assert.equal(report.config.mcpServers.roles.env.STACK_MCP_OPERATOR, operatorHeaders(f.env).authorization);
        assert.equal(report.config.mcpServers.roles.env.STACK_STATE_DIR, f.state);
        assert.equal(report.config.mcpServers.roles.env.HOME, f.home);
        assert.equal(report.config.mcpServers.external.headers.Authorization, "Bearer private-fixture-token");
        assert.equal(report.config.mcpServers.stdio.env.ROLE_TEST_ENV, "private-fixture-env");
        assert.deepEqual(Object.keys(report.config.mcpServers).sort(), names);
        await assert.rejects(stat(report.root), { code: "ENOENT" });
      } else {
        if (harness === "codex") {
          assert.equal((await stat(report.root)).mode & 0o777, 0o700);
          assert.equal(report.ambient, null);
          assert.equal(report.authLink, join(f.env.CODEX_HOME, "auth.json"));
          assert.match(report.config, /developer_instructions = "  Role instructions/);
          assert.match(report.config, /private-fixture-token/);
          assert.match(report.config, /private-fixture-env/);
          assert.ok(report.config.includes(operatorHeaders(f.env).authorization));
          assert.doesNotMatch(report.config, /disabled-mcp|notify|ambient/);
          assert.equal(await readFile(join(report.root, "home", ".codex", "session-fixture"), "utf8"), "history");
          await assert.rejects(stat(join(report.root, "home", ".codex", "config.toml")), { code: "ENOENT" });
          await assert.rejects(stat(join(report.root, "home", ".codex", "auth.json")), { code: "ENOENT" });
        } else {
          assert.equal(report.env.project, "1");
          assert.equal(report.env.db, f.env.OPENCODE_DB);
          assert.equal(report.env.file, undefined); assert.equal(report.env.inline, undefined); assert.equal(report.env.cli, undefined);
          assert.equal(report.config.mcp.servers.external.headers["X-Test"], "private-fixture-header");
          assert.equal(report.config.mcp.servers.roles.type, "local");
          assert.equal(report.config.mcp.servers.roles.command[0], process.execPath);
          assert.equal(report.config.mcp.servers.roles.environment.STACK_MCP_OPERATOR, operatorHeaders(f.env).authorization);
          assert.equal(report.config.mcp.servers.roles.environment.STACK_STATE_DIR, f.state);
          assert.deepEqual(report.config.mcp.servers.stdio.command, [process.execPath, "--version", "one argument"]);
          assert.deepEqual(Object.keys(report.config.mcp.servers).sort(), names);
          assert.ok(report.config.plugins.includes("-opencode.config.compatibility"));
          assert.ok(report.config.plugins.includes("-opencode.config.instruction"));
          assert.equal(report.instructions, instructions);
          assert.equal(report.disposed, true);
          assert.equal(report.unauthorized, 401);
          assert.ok(Array.isArray(report.nativeConfig));
          assert.ok(report.nativeConfig.every((entry: { path: string }) => entry.path.startsWith(report.root)));
          await assert.rejects(fetch(`${report.listener}/api/config`));
          assert.equal(await readFile(join(f.env.XDG_DATA_HOME, "session-fixture"), "utf8"), "history");
          await assert.rejects(stat(report.root), { code: "ENOENT" });
        }
        await assert.rejects(stat(join(report.root, "capabilities")), { code: "ENOENT" });
      }
      const ordinaryAfter = await f.run(["--", "ordinary prompt"], { CODEX_HOME: undefined, OPENCODE_CONFIG_DIR: undefined }, harness);
      assert.deepEqual(ordinaryAfter, ordinaryBefore);
      assert.equal(await readFile(join(f.env.CODEX_HOME, "auth.json"), "utf8"), '{"fixture":"never-real-auth"}');
    }
  } finally { await f.close(); }
});

test("Role shim API installs a real PATH command, preserves both argument regions, and refuses foreign or stale files", async () => {
  const f = await setup();
  const notices: string[] = [];
  const subscription = await socketSubscribe(socketPath("roles", f.env), ["role_shims_changed"], (topic) => notices.push(topic));
  try {
    await populate(f);
    const proposed = ["default", "--with-harness", "opencode", "--with-model=astra", "--", "opencode", "--model", "openai/gpt-6-astra#medium", "--yolo"];
    const created = await f.call("role_shim_create", { name: "opencode-astra", args: proposed });
    assert.equal(created.path, join(f.bin, "opencode-astra"));
    assert.equal((await stat(created.path)).mode & 0o777, 0o700);
    assert.deepEqual((await f.call("role_shim_list")).shims, [created]);
    assert.deepEqual(created.args, proposed, "native options survive configuration unchanged");
    const shimRun = await f.run(["--title", "prompt with spaces"], {}, "opencode-astra");
    assert.equal(shimRun.code, 0, shimRun.stderr);
    const shimReport = JSON.parse(shimRun.stdout);
    assert.deepEqual(shimReport.argv.slice(-5), ["--model", "openai/gpt-6-astra#medium", "--yolo", "--title", "prompt with spaces"]);
    assert.equal(shimReport.argv[0], "--server");
    await assert.rejects(f.call("role_shim_create", { name: "opencode-astra", args: proposed }), /refusing to replace/);
    await assert.rejects(f.call("role_shim_create", { name: "opencode", args: proposed }), /cannot replace/);
    await assert.rejects(f.call("role_shim_create", { name: "escape", args: ["--", "bash"] }), /claude, codex or opencode/);
    const args = ["Research É", "--with-harness=claude", "--", "claude", "--model", "test/model", "--output-format=json"];
    const updated = await f.call("role_shim_update", { name: created.name, expectedRevision: created.revision, args });
    await assert.rejects(f.call("role_shim_update", { name: created.name, expectedRevision: created.revision, args: proposed }), /stale/);
    const result = await f.run(["--max-turns", "3", "--", "an argument with ' quotes"], {}, "opencode-astra");
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.harness, "claude");
    assert.deepEqual(report.argv.slice(-7), ["--model", "test/model", "--output-format=json", "--max-turns", "3", "--", "an argument with ' quotes"]);
    assert.equal(report.instructions, instructions);
    await symlink(join(f.bin, "claude"), join(f.bin, "foreign-shim"));
    await assert.rejects(f.call("role_shim_create", { name: "foreign-shim", args }), /refusing to replace/);
    await assert.rejects(f.call("role_shim_delete", { name: "foreign-shim", expectedRevision: updated.revision }), /not a Stack-owned/);
    const disposable = await f.call("role_shim_create", { name: "claude-test", args });
    await f.call("role_shim_delete", { name: disposable.name, expectedRevision: disposable.revision });
    await assert.rejects(stat(disposable.path), { code: "ENOENT" });
    await writeFile(updated.path, "#!/bin/sh\nexit 0\n");
    assert.deepEqual((await f.call("role_shim_list")).shims, []);
    await assert.rejects(f.call("role_shim_delete", { name: updated.name, expectedRevision: updated.revision }), /not a Stack-owned/);
    assert.equal(await readFile(updated.path, "utf8"), "#!/bin/sh\nexit 0\n");
    assert.deepEqual(notices, Array(4).fill("role_shims_changed"));
  } finally { await subscription.close(); await f.close(); }
});

test("inject forwards evolving native options without disturbing subcommand-scoped private delivery", async () => {
  const f = await setup();
  try {
    const cases = [
      { harness: "claude", native: ["--yolo", "--restricted", "--model", "test/model", "--", "--settings=prompt text"], prefix: ["--setting-sources", ""] },
      { harness: "codex", native: ["--enable", "feature_name", "--worktree", "--yolo", "--", "--remote=prompt text"], prefix: ["--no-daemon"] },
      { harness: "opencode", native: ["--auto", "run", "--yolo", "--model", "openai/gpt-6-astra#medium", "--", "--server=prompt text"], prefix: ["--auto", "run", "--server"] },
    ] as const;
    for (const { harness, native, prefix } of cases) {
      const result = await f.run(["inject", "--", harness, ...native]);
      assert.equal(result.code, 0, `${harness}: ${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.argv.slice(0, prefix.length), prefix);
      if (harness === "opencode") assert.deepEqual(report.argv.slice(4), native.slice(2));
      else assert.deepEqual(report.argv.slice(-native.length), native);
    }
    const codexExec = await f.run(["inject", "--", "codex", "--model", "test/model", "exec", "--thread-source", "fixture", "prompt"]);
    assert.equal(codexExec.code, 0, codexExec.stderr);
    assert.deepEqual(JSON.parse(codexExec.stdout).argv, ["--model", "test/model", "exec", "--thread-source", "fixture", "prompt"]);
    const escape = await f.run(["inject", "--", "opencode", "--yolo", "run", "--server=http://127.0.0.1:9"]);
    assert.equal(escape.code, 1);
    assert.match(escape.stderr, /--server bypasses a fresh private Role launch/);
  } finally { await f.close(); }
});

test("default selection is catalog-marked; empty Roles still isolate; invalid names and bypass modes fail before launch", async () => {
  const f = await setup();
  try {
    const initiallyDefault = await f.run(["inject", "--", "claude"]);
    assert.equal(initiallyDefault.code, 0, initiallyDefault.stderr);
    assert.equal(JSON.parse(initiallyDefault.stdout).instructions, "");
    await populate(f);
    const catalog = await f.call("roles_snapshot");
    const created = await f.call("role_create", { expectedRevision: catalog.revision, name: "Empty" });
    const emptyId = created.roles.find((role: { name: string }) => role.name === "Empty").id;
    await f.call("role_set_default", { expectedRevision: created.revision, roleId: emptyId });
    const named = await f.run(["inject", "Research É", "--", "claude"]);
    assert.equal(named.code, 0, named.stderr);
    assert.equal(JSON.parse(named.stdout).instructions, instructions, "an explicit name selects the non-default Role");
    for (const [selector, harness] of [[[], "claude"], [["default"], "codex"], [["Empty"], "opencode"]] as const) {
      const result = await f.run(["inject", ...selector, "--", harness]);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.skills, {});
      if (harness === "claude") assert.equal(report.instructions, "");
      if (harness === "codex") assert.match(report.config, /^developer_instructions = ""/);
      if (harness === "opencode") assert.equal(report.env.project, "1");
    }
    for (const args of [
      ["inject"], ["inject", "extra", "role", "--", "claude"], ["inject", "--", "unsupported-harness"],
      ["inject", "--with-model", "--", "claude"], ["inject", "--with-harness=", "--", "claude"],
      ["inject", "--with-model", "foo", "--with-model", "bar", "--", "claude"],
      ["inject", "--with-harness", "--with-model", "foo", "--", "claude"],
      ["inject", "missing", "--", "claude"], ["inject", "research é", "--", "claude"],
       ...["--settings=x", "--plugin-dir", "--plugin-url=x", "--remote-control", "--resume", "-r123", "--bg", "--bare", "--safe-mode", "--system-prompt=x", "attach"].map(flag => ["inject", "--", "claude", flag]),
       ...["--remote=x", "--remote-auth-token-env=KEY", "--profile=x", "-pother", "--ignore-user-config", "-cdeveloper_instructions=x", "--no-daemon=false", "resume", "app-server"].map(flag => ["inject", "--", "codex", flag]),
       ["inject", "--", "codex", "exec", "--ignore-user-config"],
      ["inject", "--", "codex", "exec", "resume"],
      ["inject", "--", "claude", "--model", "--settings=ambient.json"],
      ["inject", "--", "codex", "--model", "--profile=ambient"],
      ["inject", "--", "opencode", "--model", "--server=http://127.0.0.1:9"],
       ...["--server=x", "--standalone", "--session=x", "--continue", "--fork", "-c", "attach", "acp", "serve"].map(flag => ["inject", "--", "opencode", flag]),
    ]) {
      const result = await f.run(args);
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout, "");
    }
    const missingEnv = await f.run(["inject", "Research É", "--", "claude"], { ROLE_TEST_TOKEN: undefined });
    assert.equal(missingEnv.code, 1); assert.match(missingEnv.stderr, /ROLE_TEST_TOKEN is unavailable/);
    assert.doesNotMatch(missingEnv.stderr, /private-fixture/);
    const missingAuth = await f.run(["inject", "--", "codex"], { CODEX_HOME: join(f.home, "no-file-login") });
    assert.equal(missingAuth.code, 1); assert.match(missingAuth.stderr, /requires existing Codex file credentials/);
  } finally { await f.close(); }
});

test("termination is forwarded, capability files are cleaned, and native signal status is preserved", async () => {
  const f = await setup();
  try {
    await populate(f);
    for (const harness of ["codex", "opencode"]) {
      const ready = join(f.root, `ready-${harness}`);
      const child = spawn(process.execPath, [cli, "roles", "inject", "--", harness], { env: { ...f.env, FIXTURE_WAIT: ready }, stdio: "pipe" });
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
      });
      try {
        let report: { root: string; listener?: string } | undefined;
        for (let attempt = 0; attempt < 400; attempt++) {
          report = await readFile(ready, "utf8").then(text => JSON.parse(text), () => undefined);
          if (report) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(report, "native child reached its foreground launch");
        child.kill("SIGTERM");
        assert.deepEqual(await ended, { code: null, signal: "SIGTERM" });
        if (harness === "codex") {
          await assert.rejects(stat(join(report.root, "home", ".codex", "config.toml")), { code: "ENOENT" });
          assert.equal(await readFile(join(report.root, "home", ".codex", "session-fixture"), "utf8"), "history");
        } else {
          await assert.rejects(stat(report.root), { code: "ENOENT" });
          await assert.rejects(fetch(`${report.listener}/api/config`));
        }
      } finally { child.kill("SIGKILL"); await ended; }
    }
  } finally { await f.close(); }
});

test("the production OpenCode host uses ordinary native credentials without admitting persisted well-known or ambient capabilities", async () => {
  const f = await setup();
  let requests = 0;
  const source = createServer((_request, response) => { requests++; response.end(JSON.stringify({ config: { plugins: [join(f.home, "ambient-plugin")] } })); });
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  const config = join(f.root, "seed-config");
  await mkdir(config);
  await writeFile(join(config, "opencode.json"), JSON.stringify({ plugins: ["-opencode.config.compatibility", "-opencode.config.instruction"] }));
  try {
    // Let the pinned native package initialize its fixture database, then install
    // an ordinary fake login and well-known source as pre-existing native state.
    // No credential/profile adapter participates in the launch under test.
    const seed = await startOpenCodeHost({ ...f.env, OPENCODE_DB: undefined, OPENCODE_CONFIG_DIR: config, OPENCODE_PASSWORD: "fixture-only" }, new AbortController().signal);
    await seed.stop();
    f.env.OPENCODE_DB = join(f.env.XDG_DATA_HOME, "opencode", "opencode.db");
    assert.ok((await stat(f.env.OPENCODE_DB)).isFile(), "omitted OPENCODE_DB uses the stable native data directory");
    const credential = JSON.stringify({ type: "oauth", methodID: "chatgpt-headless", access: "FAKE_ACCESS", refresh: "FAKE_REFRESH", expires: 4102444800000, metadata: { accountID: "FAKE_ACCOUNT" } });
    const credentialId = "cred_fixture_roles_inject";
    const db = new DatabaseSync(f.env.OPENCODE_DB);
    try {
      db.prepare("INSERT INTO credential(id,integration_id,label,value,method_id,active,time_created,time_updated) VALUES(?,?,?,?,?,1,1,1)").run(credentialId, "openai", "Ordinary fake login", credential, "chatgpt-headless");
      db.prepare("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,1,1)").run("wellknown:sources", JSON.stringify([origin]));
    } finally { db.close(); }
    for (const path of [join(f.home, ".agents", "skills", "ambient"), join(f.home, ".claude", "skills", "ambient"), join(f.env.XDG_CONFIG_HOME, "opencode", "skills", "ambient")]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "SKILL.md"), "---\nname: ambient\ndescription: Do not inject\n---\nAmbient capability\n");
    }
    const sentinel = join(f.home, "ambient-imported");
    await mkdir(join(f.home, "ambient-plugin"));
    await writeFile(join(f.home, "ambient-plugin", "index.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)},'imported'); export default {id:'ambient.fixture',setup(){}};`);
    await writeFile(join(f.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ plugins: [join(f.home, "ambient-plugin")] }));
    await writeFile(join(f.home, "AGENTS.md"), "AMBIENT_HOME_INSTRUCTIONS");
    const catalog = await f.call("roles_snapshot");
    const roleId = catalog.defaultRoleId;
    await f.call("skill_create", { roleId, expectedRevision: 0, name: "role-skill", description: "Role fixture", body: "Role body" });
    await f.call("role_internal_mcp_update", { roleId, expectedRevision: 1, name: "notify", enabled: false });
    await f.call("role_internal_mcp_update", { roleId, expectedRevision: 2, name: "roles", enabled: false });
    const result = await f.run(["inject", "--", "opencode", "run", "fixture"], { FIXTURE_AUTH: credentialId, OPENCODE_DB: "opencode.db" });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.nativeSkills.some((skill: { id: string }) => skill.id === "role-skill"));
    assert.ok(!report.nativeSkills.some((skill: { id: string }) => skill.id === "ambient"));
    assert.equal(report.integration.connections.find((value: { id: string }) => value.id === credentialId).label, "Ordinary fake login");
    assert.equal(report.credentialUpdate, 204);
    assert.equal(requests, 0, "well-known URLs were never fetched, including during boot");
    await assert.rejects(stat(sentinel), { code: "ENOENT" });
    const after = new DatabaseSync(f.env.OPENCODE_DB, { readOnly: true });
    try {
      const row = after.prepare("SELECT id,label,value FROM credential WHERE id=?").get(credentialId);
      assert.equal(row?.label, "Updated through native API");
      assert.equal(row?.value, credential);
      assert.equal(after.prepare("SELECT value FROM kv WHERE key='wellknown:sources'").get()?.value, JSON.stringify([origin]));
    } finally { after.close(); }
    // A mismatched native CLI must be refused before opening/migrating any DB.
    const untouched = join(f.home, "must-not-open.db");
    const launches = join(f.state, "roles", "inject");
    const beforeLaunches = await readdir(launches);
    const mismatch = await f.run(["inject", "--", "opencode"], { FIXTURE_VERSION: "2.0.17", OPENCODE_DB: untouched });
    assert.equal(mismatch.code, 1); assert.match(mismatch.stderr, /matching stable OpenCode 2.0.16/);
    await assert.rejects(stat(untouched), { code: "ENOENT" });
    const failedHost = await f.run(["inject", "--", "opencode"], { OPENCODE_DB: f.home });
    assert.equal(failedHost.code, 1); assert.equal(failedHost.stdout, "");
    assert.match(failedHost.stderr, /host exited before readiness/);
    assert.deepEqual(await readdir(launches), beforeLaunches, "failed startup removes its owned capability directory");
  } finally {
    await new Promise<void>((resolve, reject) => source.close(error => error ? reject(error) : resolve()));
    await f.close();
  }
});
