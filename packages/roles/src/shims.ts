import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { workspaceRoot } from "@stack/api";

export const shimName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/, "use a command basename (letters, digits, dots, underscores or hyphens)")
  .refine((name) => !["stack", "claude", "codex", "opencode"].includes(name), "cannot replace Stack or a native harness command");
export const shimArgs = z.array(z.string().max(4_096).refine((arg) => !arg.includes("\0"), "NUL is not a command argument")).min(2).max(128)
  .superRefine((args, ctx) => {
    const separator = args.indexOf("--");
    if (separator < 0 || !["claude", "codex", "opencode"].includes(args[separator + 1] ?? ""))
      ctx.addIssue({ code: "custom", message: "give roles inject arguments with -- followed by claude, codex or opencode" });
  })
  .describe("Exact ordered arguments after 'stack roles inject', including the -- boundary. Arguments before -- select the Role and rendering context; arguments after -- belong to the native harness. Invocation arguments are appended unchanged. Native options are checked by roles inject at launch, not by the configurator.");

export type Shim = { name: string; args: string[]; path: string; revision: string };
const marker = "# stack-roles-shim-v1 ";
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** The installed script is the durable definition. There is no second registry to drift from PATH. */
export class RoleShims {
  readonly binDir: string;
  private readonly stack: string;

  constructor(env: NodeJS.ProcessEnv, root = workspaceRoot(import.meta.dirname)) {
    this.binDir = env.STACK_INSTALL_BIN_DIR ?? join(env.HOME ?? homedir(), ".local", "bin");
    if (!isAbsolute(this.binDir)) throw new Error("STACK_INSTALL_BIN_DIR must be absolute");
    this.stack = join(root, "bin", "stack");
  }

  private path(name: string): string { return join(this.binDir, shimName.parse(name)); }

  private script(name: string, args: string[]): string {
    const metadata = Buffer.from(JSON.stringify({ name, args })).toString("base64");
    return `#!/bin/sh\n${marker}${metadata}\nexec ${[this.stack, "roles", "inject", ...args].map(quote).join(" ")} "$@"\n`;
  }

  private read(name: string): Shim | null {
    const path = this.path(name);
    try {
      if (!lstatSync(path).isFile()) return null;
      const info = statSync(path);
      if (info.size > 1_000_000 || !(info.mode & 0o111)) return null;
      const text = readFileSync(path, "utf8");
      const line = text.split("\n", 3)[1];
      if (!line?.startsWith(marker)) return null;
      const data: unknown = JSON.parse(Buffer.from(line.slice(marker.length), "base64").toString("utf8"));
      if (!data || typeof data !== "object" || !("name" in data) || !("args" in data) || data.name !== name) return null;
      const args = shimArgs.parse(data.args);
      if (text !== this.script(name, args)) return null;
      return { name, args, path, revision: revisionOf(text) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // An independent command (including an invalid or edited script) is never ours to manage.
      if (error instanceof SyntaxError || error instanceof z.ZodError) return null;
      throw error;
    }
  }

  list(): { binDir: string; shims: Shim[] } {
    if (!existsSync(this.binDir)) return { binDir: this.binDir, shims: [] };
    const shims = readdirSync(this.binDir).filter((name) => shimName.safeParse(name).success)
      .flatMap((name) => this.read(name) ?? []);
    return { binDir: this.binDir, shims };
  }

  private temporary(name: string, text: string): string {
    const path = join(this.binDir, `.${name}.${randomUUID()}.tmp`);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700);
    try { writeFileSync(fd, text); fchmodSync(fd, 0o700); }
    catch (error) { closeSync(fd); unlinkSync(path); throw error; }
    closeSync(fd);
    return path;
  }

  create(name: string, args: string[]): Shim {
    const path = this.path(name);
    args = shimArgs.parse(args);
    if (!statSync(this.binDir).isDirectory()) throw new Error(`not a command directory: ${this.binDir}`);
    const temporary = this.temporary(name, this.script(name, args));
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`refusing to replace an existing command: ${path}`);
      throw error;
    } finally { unlinkSync(temporary); }
    return this.read(name)!;
  }

  update(name: string, expectedRevision: string, args: string[]): Shim {
    const current = this.owned(name, expectedRevision);
    args = shimArgs.parse(args);
    const text = this.script(name, args);
    if (revisionOf(text) === current.revision) return current;
    const temporary = this.temporary(name, text);
    try {
      this.owned(name, expectedRevision);
      renameSync(temporary, current.path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return this.read(name)!;
  }

  delete(name: string, expectedRevision: string): void {
    const current = this.owned(name, expectedRevision);
    unlinkSync(current.path);
  }

  private owned(name: string, expectedRevision: string): Shim {
    const current = this.read(name);
    if (!current) throw new Error(`not a Stack-owned Role shim: ${this.path(name)}`);
    if (current.revision !== expectedRevision) throw new Error(`stale Role shim revision: ${name}`);
    return current;
  }
}
