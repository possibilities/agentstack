import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { PackageCli } from "./index.js";

const manifestSchema = z.object({
  description: z.string().trim().min(1),
  usage: z.string().trim().min(1).optional(),
  exec: z.array(z.string().min(1)).min(1).optional(),
}).strict();

type Command = { name: string; dir: string; yaml: boolean; ts: boolean };

async function commands(root: string): Promise<Command[]> {
  const entries = await readdir(join(root, "packages"), { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory()).flatMap(entry => {
    const dir = join(root, "packages", entry.name);
    const yaml = existsSync(join(dir, "cli.yaml"));
    const ts = existsSync(join(dir, "cli.ts"));
    return yaml || ts ? [{ name: entry.name, dir, yaml, ts }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function manifest(command: Command): Promise<z.infer<typeof manifestSchema> | undefined> {
  if (!command.yaml) return undefined;
  const file = join(command.dir, "cli.yaml");
  let value: unknown;
  try { value = parse(await readFile(file, "utf8")); }
  catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const result = manifestSchema.safeParse(value);
  if (!result.success) throw new Error(`${file}: ${result.error.issues[0]?.message}`);
  if (Boolean(result.data.exec) === command.ts) throw new Error(`${file}: use exactly one of cli.ts or exec`);
  return result.data;
}

async function implementation(command: Command): Promise<PackageCli> {
  const file = join(command.dir, "dist", "cli.js");
  if (!existsSync(file)) throw new Error(`${command.name} CLI is not built; run pnpm build`);
  const loaded: unknown = (await import(pathToFileURL(file).href)).default;
  if (!loaded || typeof loaded !== "object" || typeof (loaded as PackageCli).run !== "function")
    throw new Error(`${file}: default export must implement PackageCli`);
  return loaded as PackageCli;
}

function runExec(argv: string[], dir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

export async function dispatch(args: string[], root: string): Promise<number> {
  const found = await commands(root);
  const [requested, ...rest] = args;
  const name = requested;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const lines = await Promise.all(found.map(async command => {
      const config = await manifest(command);
      const description = config?.description ?? (await implementation(command)).description;
      if (!description) throw new Error(`${command.dir}/cli.ts: description is required without cli.yaml`);
      return `  ${command.name.padEnd(14)} ${description}`;
    }));
    console.log(`usage: stack <package> [args...]\n\nCommands:\n${lines.join("\n")}\n\nRun stack <package> --help for package help.`);
    return 0;
  }
  const command = found.find(entry => entry.name === name);
  if (!command) { console.error(`unknown stack command: ${requested}. Run stack --help.`); return 1; }
  const config = await manifest(command);
  const argv = rest;
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    const description = config?.description ?? (await implementation(command)).description;
    console.log(`stack ${name}: ${description}\n${config?.usage ?? `usage: stack ${name} [args...]`}`);
    return 0;
  }
  if (config?.exec) return runExec([...config.exec, ...argv], command.dir);
  const result = await (await implementation(command)).run(argv);
  return result ?? 0;
}
