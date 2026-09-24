import { z } from "zod";
import { isAbsolute } from "node:path";

export const resourceId = z.uuid().describe("Stable role resource ID.");
export const resourceName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).describe("Unique lowercase name used in the private launch directory or MCP config.");
export const resourceDescription = z.string().max(4_000);
export const skillBody = z.string().max(262_144).describe("Markdown body of SKILL.md; name and description frontmatter is generated from the record.");

const base64 = z.string().max(262_144).refine((value) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}, "file content must be canonical base64");

export const skillFile = z.strictObject({
  path: z.string().min(1).max(240).refine((path) => path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) && path.toLowerCase() !== "skill.md", "relative skill file path is required; SKILL.md is generated"),
  contentBase64: base64.describe("File bytes as base64, including scripts or other supporting assets."),
});
export const skillFiles = z.array(skillFile).max(128).superRefine((files, ctx) => {
  const paths = new Set<string>();
  for (const file of files) {
    const path = file.path.toLowerCase();
    const parts = path.split("/");
    if (paths.has(path) || parts.slice(0, -1).some((_part, index) => paths.has(parts.slice(0, index + 1).join("/")))) {
      ctx.addIssue({ code: "custom", message: `duplicate or conflicting skill file path: ${file.path}` });
    }
    paths.add(path);
  }
  for (const path of paths) if ([...paths].some((other) => other !== path && other.startsWith(`${path}/`))) {
    ctx.addIssue({ code: "custom", message: `skill file is also a directory: ${path}` });
  }
});
export const skillRecord = z.strictObject({
  id: resourceId, name: resourceName, description: resourceDescription.min(1), body: skillBody,
  files: skillFiles, enabled: z.boolean(),
});
export type Skill = z.infer<typeof skillRecord>;

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const headerName = z.string().regex(/^[A-Za-z0-9-]+$/);
const textMap = (key: z.ZodString) => z.record(key, z.string().max(16_384));
export const mcpDefinition = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("http"),
    url: z.url().refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
    }, "MCP URL must be HTTP(S) without credentials or a fragment"),
    bearerTokenEnvVar: envName.optional(),
    httpHeaders: textMap(headerName).optional(),
    envHttpHeaders: z.record(headerName, envName).optional(),
  }),
  z.strictObject({
    type: z.literal("stdio"), command: z.string().min(1).max(4_096),
    args: z.array(z.string().max(16_384)).max(128),
    env: textMap(envName).optional(),
    envVars: z.array(envName).max(128).optional(),
  }),
]);
export const mcpRecord = z.strictObject({
  id: resourceId, name: resourceName, description: resourceDescription,
  definition: mcpDefinition, enabled: z.boolean(),
});
export type RoleMcpServer = z.infer<typeof mcpRecord>;

export const projectPath = z.string().min(1).max(4_096).refine(isAbsolute, "project root must be an absolute path").describe("Absolute project root whose config may be trusted for bots launched inside it.");
export const trustedProjectRecord = z.strictObject({
  id: resourceId, path: projectPath, description: resourceDescription, enabled: z.boolean(),
});
export type TrustedProject = z.infer<typeof trustedProjectRecord>;
