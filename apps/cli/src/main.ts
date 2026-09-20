import { spawn, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { RestartAdmission, StatusResponse } from "@agentstack/contracts";
import {
  CONTROL_SCHEMA,
  isChildId,
  statusExitCode,
} from "@agentstack/contracts";
import { controlRequest, resolveRuntimePaths } from "@agentstack/runtime";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const paths = resolveRuntimePaths();

function systemctl(...values: string[]) {
  return spawnSync("systemctl", ["--user", ...values], { encoding: "utf8" });
}

function unitState(): { active: boolean; state: string; detail?: string } {
  const result = systemctl("is-active", "agentstack.service");
  return {
    active: result.status === 0,
    state: (result.stdout || "unknown").trim(),
    ...(result.stderr.trim()
      ? { detail: result.stderr.trim().slice(0, 512) }
      : {}),
  };
}

async function status(json: boolean): Promise<number> {
  const unit = unitState();
  let control: StatusResponse | null = null;
  let controlError: string | null = null;
  try {
    control = await controlRequest<StatusResponse>(
      paths.controlSocket,
      "GET",
      "/v1/status",
    );
  } catch (error) {
    controlError = error instanceof Error ? error.message : String(error);
  }
  const exit = statusExitCode(unit.active, control);
  const healthy = exit === 0;
  if (json) {
    console.log(
      JSON.stringify(
        { schema: CONTROL_SCHEMA, healthy, exit, unit, control, controlError },
        null,
        2,
      ),
    );
  } else if (!control) {
    console.log(`AgentStack: ${unit.state}; control socket unavailable`);
  } else {
    console.log(
      `AgentStack ${control.runningVersion}: ${unit.state}${control.installedVersion !== control.runningVersion ? " (restart required)" : ""}`,
    );
    for (const child of Object.values(control.children)) {
      console.log(
        `${child.id}: ${child.observedState}, ${child.readiness}, pid ${child.pid ?? "-"}, generation ${child.generation ?? "-"}`,
      );
    }
  }
  return exit;
}

function service(
  action: "start" | "stop" | "restart" | "disable",
  now = false,
): number {
  const argv =
    action === "disable" && now
      ? ["disable", "--now", "agentstack.service"]
      : [action, "agentstack.service"];
  const result = systemctl(...argv);
  if (result.status !== 0) process.stderr.write(result.stderr || result.stdout);
  return result.status ?? 5;
}

function enable(now: boolean): number {
  const reload = systemctl("daemon-reload");
  if (reload.status !== 0) {
    process.stderr.write(reload.stderr || reload.stdout);
    return reload.status ?? 5;
  }
  const result = systemctl(
    "enable",
    ...(now ? ["--now"] : []),
    "agentstack.service",
  );
  if (result.status !== 0) process.stderr.write(result.stderr || result.stdout);
  return result.status ?? 5;
}

async function doctor(json: boolean): Promise<number> {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const unit = systemctl("show", "--property=LoadState", "agentstack.service");
  checks.push({
    id: "user-manager",
    ok: unit.status === 0,
    detail: (unit.stdout || unit.stderr).trim().slice(0, 512),
  });
  try {
    const info = await stat(paths.runtimeRoot);
    checks.push({
      id: "runtime-directory",
      ok: info.isDirectory() && (info.mode & 0o077) === 0,
      detail: paths.runtimeRoot,
    });
  } catch {
    checks.push({
      id: "runtime-directory",
      ok: false,
      detail: "created when the service starts",
    });
  }
  const ok = checks.every((check) => check.ok);
  if (json)
    console.log(
      JSON.stringify({ schema: CONTROL_SCHEMA, ok, checks }, null, 2),
    );
  else
    for (const check of checks)
      console.log(`${check.ok ? "ok" : "fail"} ${check.id}: ${check.detail}`);
  return ok ? 0 : 5;
}

async function childRestart(id: string | undefined): Promise<number> {
  if (!id || !isChildId(id)) {
    process.stderr.write("child restart requires codex or fx\n");
    return 2;
  }
  try {
    const receipt = await controlRequest<RestartAdmission>(
      paths.controlSocket,
      "POST",
      `/v1/children/${id}/restart`,
    );
    if (!receipt.accepted || receipt.outcome !== "admitted")
      throw new Error("restart was not admitted");
    console.log(
      `Restart admitted for ${id} (${receipt.requestId}); inspect agentstack status for terminal state`,
    );
    return 0;
  } catch {
    throw new Error(
      `Restart outcome unknown for ${id}; inspect agentstack status before retrying`,
    );
  }
}

async function installedProductVersion(): Promise<string> {
  const roots = [
    process.env.AGENTSTACK_RELEASE_ROOT,
    "/usr/lib/agentstack/current",
  ].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    try {
      const manifest = JSON.parse(
        await readFile(`${root}/manifest.json`, "utf8"),
      ) as { productVersion?: unknown };
      if (
        typeof manifest.productVersion === "string" &&
        manifest.productVersion
      )
        return manifest.productVersion;
    } catch {
      // Try the next immutable release root.
    }
  }
  return "development";
}

function logs(): Promise<number> {
  const component = args.includes("--component")
    ? args[args.indexOf("--component") + 1]
    : undefined;
  const journalArgs = [
    "--user-unit",
    "agentstack.service",
    ...(args.includes("--follow") ? ["--follow"] : []),
    "--output",
    "cat",
  ];
  const child = spawn("journalctl", journalArgs, {
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (!component || text.includes(`\"component\":\"${component}\"`))
      process.stdout.write(text);
  });
  return new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 5)),
  );
}

function help(): void {
  console.log(
    `Usage: agentstack <command>\n\nCommands:\n  status [--json]            Inspect unit and engine readiness\n  start | stop | restart     Control this user's session service\n  enable [--now]             Enable for this user's login sessions; never enables linger\n  disable [--now]            Disable this user's service\n  child restart <codex|fx>   Restart one owned engine\n  logs [--component ID] [--follow]\n  doctor [--json]\n  version [--json]\n  daemon                     Development/package entrypoint (launcher only)\n\nStatus exits: 0 healthy, 3 stopped, 4 degraded, 5 incompatible/error.`,
  );
}

async function main(): Promise<number> {
  switch (command) {
    case "status":
      return await status(args.includes("--json"));
    case "start":
      return service("start");
    case "stop":
      return service("stop");
    case "restart":
      return service("restart");
    case "enable":
      return enable(args.includes("--now"));
    case "disable":
      return service("disable", args.includes("--now"));
    case "child":
      return args[1] === "restart" ? await childRestart(args[2]) : 2;
    case "logs":
      return await logs();
    case "doctor":
      return await doctor(args.includes("--json"));
    case "version":
      const version = await installedProductVersion();
      if (args.includes("--json"))
        console.log(JSON.stringify({ schema: CONTROL_SCHEMA, version }));
      else console.log(`agentstack ${version}`);
      return 0;
    case "help":
    case "--help":
    case "-h":
      help();
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      help();
      return 2;
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 5;
  },
);
