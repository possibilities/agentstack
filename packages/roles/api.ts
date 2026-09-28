import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { configuredMcpPackages, mcpPort, operation, workspaceRoot, type PackageApi } from "@agentstack/api";
import { matchingProjects, ownerMcpOrigins, roleMcpConfig, roleMcpConflict } from "./src/bundle.js";
import { RoleStore, instructionLimitBytes, renderSegments, snapshotLimitChars } from "./src/store.js";
import { mcpDefinition, mcpRecord, projectPath, resourceName, resourceDescription, skillBody, skillFiles, skillRecord, trustedProjectRecord } from "./src/resources.js";

const id = z.uuid().describe("Stable Role record ID.");
const revision = z.number().int().nonnegative().describe("Expected role revision; stale writes fail.");
const title = z.string().trim().min(1).max(200);
const description = z.string().max(4_000);
const body = z.string().max(262_144).describe("Verbatim developer instruction body; metadata never renders.");
const stamp = z.number().int().nullable().describe("Unix milliseconds; null for records written before timestamps were kept.");
const stamps = { createdAt: stamp, updatedAt: stamp.describe("Unix milliseconds of the last change to this record's own fields; reordering does not count. Null for older records.") };
const fragment = z.strictObject({ id, categoryId: id, title, description, body, enabled: z.boolean(), ...stamps });
const category = z.strictObject({ id, title, description, enabled: z.boolean(), fragments: z.array(fragment), ...stamps });
const index = z.number().int().nonnegative().describe("Zero-based position within the category.");
const launchSnapshot = z.strictObject({ revision, categories: z.array(category), skills: z.array(skillRecord), mcpServers: z.array(mcpRecord), trustedProjects: z.array(trustedProjectRecord) });
const snapshot = launchSnapshot.extend({ mcpServers: z.array(mcpRecord.omit({ definition: true }).extend({ transport: z.enum(["http", "stdio"]) })) });
const segment = z.strictObject({ categoryId: id, fragmentId: id,
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).describe("One rendered fragment body as [start, end) string offsets; separators belong to no segment.");
const preview = z.strictObject({ revision, rendered: z.string(), segments: z.array(segment),
  bytes: z.number().int().nonnegative().describe("UTF-8 size of rendered."), limitBytes: z.number().int().positive().describe("Largest rendered size an edit may produce.") });
const write = z.strictObject({ expectedRevision: revision });
const count = z.number().int().nonnegative();
const launchPreview = z.strictObject({
  revision,
  instructions: z.strictObject({ bytes: count.describe("UTF-8 size of SYSTEM_APPEND.md."), limitBytes: count, fragments: count.describe("Fragments that render.") }),
  skills: z.array(z.strictObject({ id, name: resourceName, description: resourceDescription, files: count.describe("Supporting files beside SKILL.md."),
    bytes: count.describe("Decoded size of the body and supporting files.") })).describe("Enabled role skills in order; each becomes skills/<name>/SKILL.md."),
  internalMcpServers: z.array(z.string()).describe("Owner-provided Package API MCP servers every Bot receives; each launch binds their URLs to that Bot."),
  mcpServers: z.array(z.strictObject({ id, name: resourceName, type: z.enum(["http", "stdio"]) })).describe("Enabled role MCP servers in order."),
  config: z.string().describe("The config.toml tables the Role contributes for its enabled MCP servers, exactly as launches write them."),
  trustedProjects: z.array(z.strictObject({ id, path: projectPath })).describe("Enabled trusted project roots in order."),
  cwds: z.array(z.strictObject({
    cwd: z.string().describe("The working directory as given."),
    path: z.string().nullable().describe("Its canonical path, or null when it does not exist."),
    trustedProjectIds: z.array(id).describe("Enabled trusted projects whose root contains it; a launch there trusts each."),
  })).describe("Each requested working directory, matched against trusted project roots."),
  issues: z.array(z.strictObject({ id, name: resourceName, message: z.string() })).describe("Enabled role MCP servers that would stop every Bot launch until changed or disabled."),
  snapshotChars: count.describe("JSON size of the complete Role, including MCP connection definitions."),
  snapshotLimitChars: count.describe("Largest complete Role JSON size a write may leave behind."),
});

export type RolesContext = { store: RoleStore; changed?: () => void; mcpOrigins?: readonly string[] };
function summarize(result: z.infer<typeof launchSnapshot>): z.infer<typeof snapshot> {
  return { ...result, mcpServers: result.mcpServers.map(({ definition, ...record }) => ({ ...record, transport: definition.type })) };
}
function changed(ctx: RolesContext, result: z.infer<typeof launchSnapshot>) { ctx.changed?.(); return summarize(result); }
const internalMcpNames = async () => (await configuredMcpPackages(workspaceRoot(import.meta.dirname))).map((pkg) => pkg.name);
/** Refuse a role MCP server a launch would refuse, whether or not it is enabled now. */
async function ensureRoleMcp(ctx: RolesContext, name?: string, definition?: z.infer<typeof mcpDefinition>): Promise<void> {
  const origins = new Set(ctx.mcpOrigins ?? []);
  if (name && (await internalMcpNames()).some((internal) => internal.toLowerCase() === name.toLowerCase())) throw new Error(`role MCP server ${name} collides with an internal Package API`);
  if (definition?.type === "http" && origins.has(new URL(definition.url).origin)) throw new Error("role MCP server URL cannot alias the internal MCP listener");
}

export const roleSnapshot = operation({
  name: "role_snapshot", description: "Read the role's instructions, skills, trusted projects, MCP server summaries, and revision. MCP connection definitions are omitted because URLs, arguments, headers and environment values can contain credentials.",
  input: z.strictObject({}), output: snapshot, annotations: { title: "Read role", readOnlyHint: true },
  async call(ctx: RolesContext) { return summarize(ctx.store.snapshot()); },
});
export const roleLaunchSnapshot = operation({
  name: "role_launch_snapshot", description: "Read the complete Role for native runtime launch, including credential-bearing MCP connection definitions. Keep the result in private launch state and out of model transcripts.",
  input: z.strictObject({}), output: launchSnapshot, annotations: { title: "Read launch role", readOnlyHint: true },
  async call(ctx: RolesContext) { return ctx.store.snapshot(); },
});
export const roleEditorSnapshot = operation({
  name: "role_editor_snapshot", description: "Read the complete Role for the operator's resource editor, including credential-bearing MCP connection definitions. Keep this result out of model transcripts.",
  input: z.strictObject({}), output: launchSnapshot, annotations: { title: "Read role editor", readOnlyHint: true },
  async call(ctx: RolesContext) { return ctx.store.snapshot(); },
});
export const rolePreview = operation({
  name: "role_preview", description: "Preview the exact developer instruction text from the role for the next bot launch; descriptions and titles are excluded.",
  input: z.strictObject({}), output: preview, annotations: { title: "Preview role", readOnlyHint: true },
  async call(ctx: RolesContext) {
    const value = ctx.store.snapshot();
    const { rendered, segments } = renderSegments(value);
    return { revision: value.revision, rendered, segments, bytes: Buffer.byteLength(rendered), limitBytes: instructionLimitBytes };
  },
});
export const roleLaunchPreview = operation({
  name: "role_launch_preview", description: "Preview what the next Bot launch receives from the role besides its instructions: enabled skills, MCP servers and their config.toml, trusted project roots matched against given working directories, and anything that would stop a launch.",
  input: z.strictObject({ cwds: z.array(z.string().max(4_096).refine(isAbsolute, "working directory must be an absolute path")).max(64).optional()
    .describe("Working directories to match against trusted project roots, such as each Bot's cwd.") }),
  output: launchPreview, annotations: { title: "Preview role launch", readOnlyHint: true },
  async call(ctx: RolesContext, { cwds = [] }) {
    const value = ctx.store.snapshot();
    const { rendered, segments } = renderSegments(value);
    const internal = await internalMcpNames();
    const ownerNames = new Set(internal.map((name) => name.toLowerCase()));
    const origins = new Set(ctx.mcpOrigins ?? []);
    const issues = value.mcpServers.flatMap((server) => {
      const message = roleMcpConflict(server, ownerNames, origins);
      return message ? [{ id: server.id, name: server.name, message }] : [];
    });
    const enabledProjects = value.trustedProjects.filter((project) => project.enabled);
    return {
      revision: value.revision,
      instructions: { bytes: Buffer.byteLength(rendered), limitBytes: instructionLimitBytes, fragments: segments.length },
      skills: value.skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, files: skill.files.length,
        bytes: Buffer.byteLength(skill.body) + skill.files.reduce((sum, file) => sum + Buffer.from(file.contentBase64, "base64").length, 0) })),
      internalMcpServers: internal,
      mcpServers: value.mcpServers.filter((server) => server.enabled).map((server) => ({ id: server.id, name: server.name, type: server.definition.type })),
      config: roleMcpConfig(value),
      trustedProjects: enabledProjects.map((project) => ({ id: project.id, path: project.path })),
      cwds: await Promise.all([...new Set(cwds)].map(async (cwd) => {
        const path = await realpath(cwd).catch(() => null);
        return { cwd, path, trustedProjectIds: path ? matchingProjects(value, path).map((project) => project.id) : [] };
      })),
      issues,
      snapshotChars: JSON.stringify(value).length,
      snapshotLimitChars,
    };
  },
});
export const categoryCreate = operation({
  name: "category_create", description: "Create an ordered category at the end of the role. Pass the current revision.",
  input: write.extend({ title, description: description.optional(), enabled: z.boolean().optional() }), output: snapshot,
  annotations: { title: "Create category" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.createCategory(input.expectedRevision, input.title, input.description, input.enabled)); },
});
export const categoryUpdate = operation({
  name: "category_update", description: "Update a category's title, human-only description, or enabled state. A disabled category contributes no fragments.",
  input: write.extend({ id, title: title.optional(), description: description.optional(), enabled: z.boolean().optional() }), output: snapshot,
  annotations: { title: "Update category" },
  async call(ctx: RolesContext, { id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.updateCategory(expectedRevision, id, fields)); },
});
export const categoryDelete = operation({
  name: "category_delete", description: "Delete an empty category. Move or delete its fragments first; no implicit content deletion.",
  input: write.extend({ id }), output: snapshot, annotations: { title: "Delete category", destructiveHint: true },
  async call(ctx: RolesContext, { id, expectedRevision }) { return changed(ctx, ctx.store.deleteCategory(expectedRevision, id)); },
});
export const categoryReorder = operation({
  name: "category_reorder", description: "Atomically replace category order with an exact permutation of all category IDs.",
  input: write.extend({ ids: z.array(id) }), output: snapshot, annotations: { title: "Reorder categories" },
  async call(ctx: RolesContext, { ids, expectedRevision }) { return changed(ctx, ctx.store.reorderCategories(expectedRevision, ids)); },
});
export const fragmentCreate = operation({
  name: "fragment_create", description: "Create a fragment at the end of a category, or at index. Only enabled bodies in enabled categories render.",
  input: write.extend({ categoryId: id, title, body, description: description.optional(), enabled: z.boolean().optional(), index: index.optional() }), output: snapshot,
  annotations: { title: "Create instruction fragment" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.createFragment(input.expectedRevision, input.categoryId, input.title, input.body, input.description, input.enabled, input.index)); },
});
export const fragmentUpdate = operation({
  name: "fragment_update", description: "Update content or metadata, enable/disable, or move to another category (appended there). Reorder separately if needed.",
  input: write.extend({ id, categoryId: id.optional(), title: title.optional(), body: body.optional(), description: description.optional(), enabled: z.boolean().optional() }), output: snapshot,
  annotations: { title: "Update instruction fragment" },
  async call(ctx: RolesContext, { id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.updateFragment(expectedRevision, id, fields)); },
});
export const fragmentDelete = operation({
  name: "fragment_delete", description: "Delete a fragment from its category and the role.",
  input: write.extend({ id }), output: snapshot, annotations: { title: "Delete instruction fragment", destructiveHint: true },
  async call(ctx: RolesContext, { id, expectedRevision }) { return changed(ctx, ctx.store.deleteFragment(expectedRevision, id)); },
});
export const fragmentReorder = operation({
  name: "fragment_reorder", description: "Atomically replace one category's fragment order with an exact permutation of its fragment IDs.",
  input: write.extend({ categoryId: id, ids: z.array(id) }), output: snapshot, annotations: { title: "Reorder instruction fragments" },
  async call(ctx: RolesContext, { categoryId, ids, expectedRevision }) { return changed(ctx, ctx.store.reorderFragments(expectedRevision, categoryId, ids)); },
});

export const fragmentMove = operation({
  name: "fragment_move", description: "Atomically place a fragment at a zero-based index of a category, its own or another. Index counts the destination's other fragments.",
  input: write.extend({ id, categoryId: id, index }), output: snapshot, annotations: { title: "Move instruction fragment" },
  async call(ctx: RolesContext, { id, categoryId, index, expectedRevision }) { return changed(ctx, ctx.store.moveFragment(expectedRevision, id, categoryId, index)); },
});

export const skillCreate = operation({
  name: "skill_create", description: "Add a role-owned skill. AgentStack generates SKILL.md frontmatter from the name and description; supporting files are private base64-encoded bytes. Only enabled skills enter later bot launches.",
  input: write.extend({ name: resourceName, description: resourceDescription.min(1), body: skillBody, files: skillFiles.optional(), enabled: z.boolean().optional() }),
  output: snapshot, annotations: { title: "Create role skill" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.createSkill(input.expectedRevision, input.name, input.description, input.body, input.files, input.enabled)); },
});
export const skillUpdate = operation({
  name: "skill_update", description: "Edit skill name, description, Markdown body, supporting files, or enabled state. Supplying files replaces the complete supporting-file set.",
  input: write.extend({ id, name: resourceName.optional(), description: resourceDescription.min(1).optional(), body: skillBody.optional(), files: skillFiles.optional(), enabled: z.boolean().optional() }),
  output: snapshot, annotations: { title: "Update role skill" },
  async call(ctx: RolesContext, { id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.updateSkill(expectedRevision, id, fields)); },
});
export const skillDelete = operation({
  name: "skill_delete", description: "Delete a role-owned skill and all its supporting files from future launches.",
  input: write.extend({ id }), output: snapshot, annotations: { title: "Delete role skill", destructiveHint: true },
  async call(ctx: RolesContext, { id, expectedRevision }) { return changed(ctx, ctx.store.deleteSkill(expectedRevision, id)); },
});
export const skillReorder = operation({
  name: "skill_reorder", description: "Atomically replace skill order with an exact permutation of all skill IDs.",
  input: write.extend({ ids: z.array(id) }), output: snapshot, annotations: { title: "Reorder role skills" },
  async call(ctx: RolesContext, { ids, expectedRevision }) { return changed(ctx, ctx.store.reorderSkills(expectedRevision, ids)); },
});

export const mcpServerCreate = operation({
  name: "mcp_server_create", description: "Add an HTTP or stdio MCP server to the role. It joins the owner-provided internal MCP servers only on later bot launches.",
  input: write.extend({ name: resourceName, description: resourceDescription, definition: mcpDefinition, enabled: z.boolean().optional() }),
  output: snapshot, annotations: { title: "Create role MCP server" },
  async call(ctx: RolesContext, input) {
    await ensureRoleMcp(ctx, input.name, input.definition);
    return changed(ctx, ctx.store.createMcpServer(input.expectedRevision, input.name, input.description, input.definition, input.enabled));
  },
});
export const mcpServerUpdate = operation({
  name: "mcp_server_update", description: "Edit a role MCP server's name, description, full transport definition, or enabled state. Existing bot connections are unchanged until restart.",
  input: write.extend({ id, name: resourceName.optional(), description: resourceDescription.optional(), definition: mcpDefinition.optional(), enabled: z.boolean().optional() }),
  output: snapshot, annotations: { title: "Update role MCP server" },
  async call(ctx: RolesContext, { id, expectedRevision, ...fields }) {
    await ensureRoleMcp(ctx, fields.name, fields.definition);
    return changed(ctx, ctx.store.updateMcpServer(expectedRevision, id, fields));
  },
});
export const mcpServerDelete = operation({
  name: "mcp_server_delete", description: "Delete an additional role MCP server from later launches; internal owner MCP connections are unaffected.",
  input: write.extend({ id }), output: snapshot, annotations: { title: "Delete role MCP server", destructiveHint: true },
  async call(ctx: RolesContext, { id, expectedRevision }) { return changed(ctx, ctx.store.deleteMcpServer(expectedRevision, id)); },
});
export const mcpServerReorder = operation({
  name: "mcp_server_reorder", description: "Atomically replace additional MCP server order with an exact permutation of their IDs.",
  input: write.extend({ ids: z.array(id) }), output: snapshot, annotations: { title: "Reorder role MCP servers" },
  async call(ctx: RolesContext, { ids, expectedRevision }) { return changed(ctx, ctx.store.reorderMcpServers(expectedRevision, ids)); },
});

export const projectCreate = operation({
  name: "project_create", description: "Allow bots launched inside this project root to load trusted project .codex configuration, including its MCP servers. Only later launches change.",
  input: write.extend({ path: projectPath, description: resourceDescription.optional(), enabled: z.boolean().optional() }),
  output: snapshot, annotations: { title: "Trust project for bots" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.createTrustedProject(input.expectedRevision, input.path, input.description, input.enabled)); },
});
export const projectUpdate = operation({
  name: "project_update", description: "Edit a trusted project root, description, or enabled state. Disabling stops project config from entering later matching Bot launches.",
  input: write.extend({ id, path: projectPath.optional(), description: resourceDescription.optional(), enabled: z.boolean().optional() }),
  output: snapshot, annotations: { title: "Update trusted project" },
  async call(ctx: RolesContext, { id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.updateTrustedProject(expectedRevision, id, fields)); },
});
export const projectDelete = operation({
  name: "project_delete", description: "Remove a trusted project root from later Bot launches; running Bots keep their launch configuration.",
  input: write.extend({ id }), output: snapshot, annotations: { title: "Remove trusted project", destructiveHint: true },
  async call(ctx: RolesContext, { id, expectedRevision }) { return changed(ctx, ctx.store.deleteTrustedProject(expectedRevision, id)); },
});
export const projectReorder = operation({
  name: "project_reorder", description: "Atomically replace trusted project order with an exact permutation of all project IDs.",
  input: write.extend({ ids: z.array(id) }), output: snapshot, annotations: { title: "Reorder trusted projects" },
  async call(ctx: RolesContext, { ids, expectedRevision }) { return changed(ctx, ctx.store.reorderTrustedProjects(expectedRevision, ids)); },
});

export const topics = { role_changed: "The role was edited. Read role_snapshot after (re)subscribing." } as const;

export const api: PackageApi<RolesContext, keyof typeof topics> = {
  operations: [roleSnapshot, roleLaunchSnapshot, roleEditorSnapshot, rolePreview, roleLaunchPreview, categoryCreate, categoryUpdate, categoryDelete, categoryReorder,
    fragmentCreate, fragmentUpdate, fragmentDelete, fragmentReorder, fragmentMove, skillCreate, skillUpdate, skillDelete, skillReorder,
    mcpServerCreate, mcpServerUpdate, mcpServerDelete, mcpServerReorder,
    projectCreate, projectUpdate, projectDelete, projectReorder],
  events: {
    topics,
    start(ctx, publish) { ctx.changed = () => publish("role_changed"); return () => { ctx.changed = undefined; }; },
  },
  async createContext(env) {
    // The owner serves MCP on its configured port; Bots also report the bound one.
    const ports = [mcpPort(env), Number(env.AGENTSTACK_OWNER_MCP_PORT)].filter((port) => Number.isInteger(port) && port > 0);
    return { store: new RoleStore(env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack")), mcpOrigins: ports.flatMap(ownerMcpOrigins) };
  },
  async closeContext(ctx) { ctx.store.close(); },
};
