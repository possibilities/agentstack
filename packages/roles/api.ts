import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { withStateInventory, requireStateOperator, stateApplyInput, statePlan, stateReceipt, statePageInput } from "@stack/api";
import { roleStateCategories } from "./src/state-categories.js";
import { fragmentConditions, renderContext } from "./src/conditions.js";
import { configuredMcpServers, mcpPort, operation, stateDir, workspaceRoot, type PackageApi, type StandaloneContext } from "@stack/api";
import { matchingProjects, serverMcpOrigins, roleMcpConfig, roleMcpConflict } from "./src/bundle.js";
import { RoleStore, instructionLimitBytes, renderSegments, renderBotInstructions, snapshotLimitChars, roleName, roleDescription } from "./src/store.js";
import { botMarkdown } from "./src/bot-markdown.js";
import { mcpDefinition, mcpRecord, projectPath, resourceName, resourceDescription, skillBody, skillFiles, skillRecord, trustedProjectRecord } from "./src/resources.js";
import { RoleShims, shimArgs, shimName } from "./src/shims.js";
import { RoleLaunchState, launchId } from "./src/launch-state.js";

const id = z.uuid().describe("Stable Role record ID.");
const revision = z.number().int().nonnegative().describe("Expected role revision; stale writes fail.");
const roleId = z.uuid().describe("Explicit Role ID. Editing never follows a change of default.");
const selection = z.strictObject({ roleId });
const catalogRevision = z.number().int().nonnegative().describe("Expected revision from roles_snapshot. Any role or default change advances it.");
const title = z.string().trim().min(1).max(200);
const description = z.string().max(4_000);
const body = z.string().max(262_144).describe("Verbatim developer instruction body; metadata never renders.");
const stamp = z.number().int().nullable().describe("Unix milliseconds; null for records written before timestamps were kept.");
const stamps = { createdAt: stamp, updatedAt: stamp.describe("Unix milliseconds of the last change to this record's own fields; reordering does not count. Null for older records.") };
const fragment = z.strictObject({ id, categoryId: id, title, description, body, enabled: z.boolean(), conditions: fragmentConditions.optional().describe("Fragment conditions; absent on older snapshots means unconditional. Current store reads always include an object."), ...stamps });
const category = z.strictObject({ id, title, description, enabled: z.boolean(), fragments: z.array(fragment), ...stamps });
const index = z.number().int().nonnegative().describe("Zero-based position within the category.");
const role = z.strictObject({ id: roleId, name: roleName, description: roleDescription, revision, ...stamps });
const catalog = z.strictObject({ revision: catalogRevision, defaultRoleId: roleId.nullable(), workerDefaultRoleId: roleId.nullable(), roles: z.array(role) });
const launchSnapshot = role.extend({ botMarkdown: botMarkdown.optional().describe("Role-owned bot.md personality. Current reads always include it; absent on older snapshots means empty. Captured verbatim in each Bot launch; empty disables the personality. Never included in Worker or injected CLI instructions."), categories: z.array(category), skills: z.array(skillRecord), mcpServers: z.array(mcpRecord), trustedProjects: z.array(trustedProjectRecord),
  disabledInternalMcpServers: z.array(z.string()).describe("Internal MCP server names disabled for this Role. Other configured internal MCP servers are enabled, including newly added ones.") });
const snapshot = launchSnapshot.extend({ mcpServers: z.array(mcpRecord.omit({ definition: true }).extend({ transport: z.enum(["http", "stdio"]) })) });
const receipt = z.strictObject({ roleId, revision }).describe("Applied Role revision. Reread the selected Role to refresh content.");
const segment = z.strictObject({ categoryId: id, fragmentId: id,
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).describe("One rendered fragment body as [start, end) string offsets; separators belong to no segment.");
const preview = z.strictObject({ roleId, revision, rendered: z.string(), segments: z.array(segment), botMarkdown,
  botBytes: z.number().int().nonnegative().describe("UTF-8 size of the combined Bot instructions, including bot.md."),
  bytes: z.number().int().nonnegative().describe("UTF-8 size of rendered."), limitBytes: z.number().int().positive().describe("Largest rendered size an edit may produce.") });
const write = selection.extend({ expectedRevision: revision });
const count = z.number().int().nonnegative();
const internalServer = z.strictObject({ name: z.string().describe("Stable connection key."), title: z.string().describe("Display name; the key for Package APIs."),
  description: z.string(), kind: z.enum(["package", "codex"]).describe("A Package API, or a Codex tool bridge whose availability serve_codex_tools reports."), transport: z.literal("stdio").describe("Native transport for internal Bot, Worker and injected Role connections."), enabled: z.boolean() });
const launchPreview = z.strictObject({
  roleId, revision,
  instructions: z.strictObject({ bytes: count.describe("UTF-8 size of instruction fragments."), botBytes: count.describe("UTF-8 size of Bot SYSTEM_APPEND.md, including bot.md."), limitBytes: count, fragments: count.describe("Fragments that render.") }),
  skills: z.array(z.strictObject({ id, name: resourceName, description: resourceDescription, files: count.describe("Supporting files beside SKILL.md."),
    bytes: count.describe("Decoded size of the body and supporting files.") })).describe("Enabled role skills in order; each becomes skills/<name>/SKILL.md."),
  internalMcpServers: z.array(internalServer).describe("The default MCP fleet and its enablement for this Role. Only enabled servers enter new Bot and Worker launches."),
  mcpServers: z.array(z.strictObject({ id, name: resourceName, type: z.enum(["http", "stdio"]) })).describe("Enabled role MCP servers in order."),
  config: z.string().describe("The config.toml tables the Role contributes for its enabled MCP servers, exactly as launches write them."),
  trustedProjects: z.array(z.strictObject({ id, path: projectPath })).describe("Enabled trusted project roots in order."),
  cwds: z.array(z.strictObject({
    cwd: z.string().describe("The working directory as given."),
    path: z.string().nullable().describe("Its canonical path, or null when it does not exist."),
    trustedProjectIds: z.array(id).describe("Enabled trusted projects whose root contains it; a launch there trusts each."),
  })).describe("Each requested working directory, matched against trusted project roots."),
  issues: z.array(z.strictObject({ id, name: resourceName, message: z.string() })).describe("Enabled role MCP servers that would stop a launch using this Role until changed or disabled."),
  snapshotChars: count.describe("JSON size of the complete Role, including MCP connection definitions."),
  snapshotLimitChars: count.describe("Largest complete Role JSON size a write may leave behind."),
});

export type RolesContext = { store: RoleStore; shims: RoleShims; launches?: RoleLaunchState; changed?: () => void; shimsChanged?: () => void; mcpOrigins?: readonly string[] };
const standaloneReads: StandaloneContext<RolesContext> = {
  open(env) {
    const shims = new RoleShims(env), mcpOrigins = serverMcpOrigins(mcpPort(env));
    return { store: new RoleStore(stateDir(env), { readOnly: true }), shims, mcpOrigins };
  },
  close(ctx) { ctx.store.close(); },
};
function summarize(result: z.infer<typeof launchSnapshot>): z.infer<typeof snapshot> {
  return { ...result, mcpServers: result.mcpServers.map(({ definition, ...record }) => ({ ...record, transport: definition.type })) };
}
function changed(ctx: RolesContext, result: z.infer<typeof launchSnapshot>) { ctx.changed?.(); return { roleId: result.id, revision: result.revision }; }
const internalMcpServers = () => configuredMcpServers(workspaceRoot(import.meta.dirname));
const internalMcpNames = async () => (await internalMcpServers()).map((pkg) => pkg.name);
const internalRows = (servers: Awaited<ReturnType<typeof internalMcpServers>>, disabled: string[]) =>
  servers.map(({ name, title, description, kind }) => ({ name, title, description, kind, transport: "stdio" as const, enabled: !disabled.includes(name) }));
/** Refuse a role MCP server a launch would refuse, whether or not it is enabled now. */
async function ensureRoleMcp(ctx: RolesContext, name?: string, definition?: z.infer<typeof mcpDefinition>): Promise<void> {
  const origins = new Set(ctx.mcpOrigins ?? []);
  if (name && (await internalMcpNames()).some((internal) => internal.toLowerCase() === name.toLowerCase())) throw new Error(`role MCP server ${name} collides with an internal MCP server`);
  if (definition?.type === "http" && origins.has(new URL(definition.url).origin)) throw new Error("role MCP server URL cannot alias the internal MCP listener");
}

export const rolesSnapshot = operation({
  name: "roles_snapshot", description: "List Role metadata, per-role revisions, Bot and Worker default Role IDs, and the catalog revision. Every successful write advances the catalog revision.",
  input: z.strictObject({}), output: catalog, annotations: { title: "List roles", readOnlyHint: true },
  standalone: standaloneReads,
  async call(ctx: RolesContext) { return ctx.store.catalog(); },
});
export const roleCreate = operation({
  name: "role_create", description: "Create a named Role with no resources or fragments and a starter bot.md personality, without changing the Bot or Worker defaults. Supply botMarkdown to replace the starter; an empty string disables it. Pass the catalog revision from roles_snapshot. Names are unique case-insensitively.",
  input: z.strictObject({ expectedRevision: catalogRevision, name: roleName, description: roleDescription.optional(), botMarkdown: botMarkdown.optional() }), output: catalog,
  annotations: { title: "Create role" },
  async call(ctx: RolesContext, { expectedRevision, name, description, botMarkdown }) { const result = ctx.store.createRole(expectedRevision, name, description, botMarkdown); ctx.changed?.(); return result; },
});
export const roleUpdate = operation({
  name: "role_update", description: "Rename a Role, edit its human-only description, or replace its bot.md personality. Omission preserves bot.md; an empty string clears it. Bot personality edits apply on the next launch, not live, and never repeat orientation. Pass that Role's revision. Renaming does not change the default.",
  input: write.extend({ name: roleName.optional(), description: roleDescription.optional(), botMarkdown: botMarkdown.optional() }), output: receipt,
  annotations: { title: "Update role" },
  async call(ctx: RolesContext, { roleId, expectedRevision, ...fields }) { return changed(ctx, ctx.store.role(roleId).update(expectedRevision, fields)); },
});
export const roleSetDefault = operation({
  name: "role_set_default", description: "Atomically mark an existing Role as the Bot default. Worker defaults are independent. Running sessions keep their launch snapshots. Pass the catalog revision from roles_snapshot.",
  input: selection.extend({ expectedRevision: catalogRevision }), output: catalog, annotations: { title: "Set default role" },
  async call(ctx: RolesContext, { roleId, expectedRevision }) { const result = ctx.store.setDefault(expectedRevision, roleId); ctx.changed?.(); return result; },
});
export const roleSetWorkerDefault = operation({
  name: "role_set_worker_default", description: "Atomically mark an existing Role as the default for Workers started without roleId. Bot launches are unchanged. Running Workers keep their captured snapshots. Pass the catalog revision from roles_snapshot.",
  input: selection.extend({ expectedRevision: catalogRevision }), output: catalog, annotations: { title: "Set Worker default role" },
  async call(ctx: RolesContext, { roleId, expectedRevision }) { const result = ctx.store.setWorkerDefault(expectedRevision, roleId); ctx.changed?.(); return result; },
});
export const roleDelete = operation({
  name: "role_delete", description: "Delete a Role that is neither the Bot nor Worker default and all its owned resources. Reassign either default before deleting its Role. Pass the catalog revision from roles_snapshot. Existing sessions keep private snapshots.",
  input: selection.extend({ expectedRevision: catalogRevision }), output: catalog, annotations: { title: "Delete role", destructiveHint: true },
  async call(ctx: RolesContext, { roleId, expectedRevision }) { const result = ctx.store.deleteRole(expectedRevision, roleId); ctx.changed?.(); return result; },
});
export const roleInternalMcpList = operation({
  name: "role_internal_mcp_list", description: "List Stack's default MCP fleet (Package APIs and Codex tool bridges) and whether each is enabled in this Role. All are on unless explicitly disabled; new servers are on by default. These switches control launch connections, not tool availability or running sessions.",
  input: selection, output: z.strictObject({ roleId, revision, servers: z.array(internalServer) }),
  annotations: { title: "List internal role MCP servers", readOnlyHint: true },
  standalone: standaloneReads,
  async call(ctx: RolesContext, { roleId }) {
    const servers = await internalMcpServers();
    const value = ctx.store.role(roleId).snapshot();
    return { roleId, revision: value.revision, servers: internalRows(servers, value.disabledInternalMcpServers) };
  },
});
export const roleInternalMcpUpdate = operation({
  name: "role_internal_mcp_update", description: "Enable or disable one configured internal Stack MCP server for this Role's later Bot and Worker launches. Pass this Role's revision. Does not stop the package or change its transport operations. Any internal server, including roles, can be disabled; the operator can still edit through the socket or UI.",
  input: write.extend({ name: z.string().min(1), enabled: z.boolean() }), output: receipt,
  annotations: { title: "Set internal role MCP enablement" },
  async call(ctx: RolesContext, { roleId, expectedRevision, name, enabled }) {
    if (!(await internalMcpNames()).includes(name)) throw new Error(`unknown internal MCP server: ${name}`);
    return changed(ctx, ctx.store.role(roleId).setInternalMcp(expectedRevision, name, enabled));
  },
});
export const roleSnapshot = operation({
  name: "role_snapshot", description: "Read the role's instructions, skills, trusted projects, MCP server summaries, and revision. MCP connection definitions are omitted because URLs, arguments, headers and environment values can contain credentials.",
  input: selection, output: snapshot, annotations: { title: "Read role", readOnlyHint: true },
  standalone: standaloneReads,
  async call(ctx: RolesContext, { roleId }) { return summarize(ctx.store.role(roleId).snapshot()); },
});
export const roleLaunchSnapshot = operation({
  name: "role_launch_snapshot", description: "Atomically read a selected Role or resolve the Bot or Worker default for a native launch. Includes credential-bearing MCP definitions; keep this private snapshot out of model transcripts. An unknown Role fails.",
  input: z.strictObject({ roleId: roleId.optional().describe("Explicit Role; omit for the audience's default."), audience: z.enum(["bot", "worker"]).optional().describe("Audience whose default to use; bot when omitted.") }),
  output: launchSnapshot, annotations: { title: "Read launch role", readOnlyHint: true },
  standalone: standaloneReads,
  async call(ctx: RolesContext, { roleId, audience }) { return ctx.store.launchSnapshot(roleId, audience); },
});
export const roleEditorSnapshot = operation({
  name: "role_editor_snapshot", description: "Read the complete Role for the operator's resource editor, including credential-bearing MCP connection definitions. Keep this result out of model transcripts.",
  input: selection, output: launchSnapshot, annotations: { title: "Read role editor", readOnlyHint: true },
  standalone: standaloneReads,
  async call(ctx: RolesContext, { roleId }) { return ctx.store.role(roleId).snapshot(); },
});
export const rolePreview = operation({
  name: "role_preview", description: "Preview exact instruction fragments for explicit rendering context, plus the separate Bot-only bot.md personality and combined Bot byte count. Omitted context includes only unconditional fragments. Descriptions and titles are excluded. Context does not configure a native runtime.",
  input: selection.extend({ context: renderContext.optional() }), output: preview, annotations: { title: "Preview role", readOnlyHint: true },
  standalone: standaloneReads,
  async call(ctx: RolesContext, { roleId, context }) {
    const value = ctx.store.role(roleId).snapshot();
    const { rendered, segments } = renderSegments(value, context);
    return { roleId, revision: value.revision, rendered, segments, botMarkdown: value.botMarkdown ?? "", botBytes: Buffer.byteLength(renderBotInstructions(value, context)), bytes: Buffer.byteLength(rendered), limitBytes: instructionLimitBytes };
  },
});
export const roleLaunchPreview = operation({
  name: "role_launch_preview", description: "Preview the selected Role's enabled skills, MCP servers and config.toml, trusted project roots, and launch issues. Instruction counts use explicit rendering context; omitted context includes only unconditional fragments.",
  input: selection.extend({ context: renderContext.optional(), cwds: z.array(z.string().max(4_096).refine(isAbsolute, "working directory must be an absolute path")).max(64).optional()
    .describe("Working directories to match against trusted project roots, such as each Bot's cwd.") }),
  output: launchPreview, annotations: { title: "Preview role launch", readOnlyHint: true },
  standalone: standaloneReads,
  async call(ctx: RolesContext, { roleId, cwds = [], context }) {
    const value = ctx.store.role(roleId).snapshot();
    const { rendered, segments } = renderSegments(value, context);
    const internal = await internalMcpServers();
    const serverNames = new Set(internal.map(({ name }) => name.toLowerCase()));
    const origins = new Set(ctx.mcpOrigins ?? []);
    const issues = value.mcpServers.flatMap((server) => {
      const message = roleMcpConflict(server, serverNames, origins);
      return message ? [{ id: server.id, name: server.name, message }] : [];
    });
    const enabledProjects = value.trustedProjects.filter((project) => project.enabled);
    return {
      roleId,
      revision: value.revision,
      instructions: { bytes: Buffer.byteLength(rendered), botBytes: Buffer.byteLength(renderBotInstructions(value, context)), limitBytes: instructionLimitBytes, fragments: segments.length },
      skills: value.skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, files: skill.files.length,
        bytes: Buffer.byteLength(skill.body) + skill.files.reduce((sum, file) => sum + Buffer.from(file.contentBase64, "base64").length, 0) })),
      internalMcpServers: internalRows(internal, value.disabledInternalMcpServers),
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
const shim = z.strictObject({ name: shimName, args: shimArgs, path: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/) });
const shimRevision = shim.shape.revision.describe("SHA-256 of the installed script from role_shim_list; stale writes fail.");
export const roleShimList = operation({
  name: "role_shim_list", description: "List Stack-owned Role injection commands installed in Stack's command directory. Scripts are durable definitions; unrelated or edited files are not adopted. The directory defaults to ~/.local/bin, as in scripts/install.sh; STACK_INSTALL_BIN_DIR selects another directory for this server.",
  input: z.strictObject({}), output: z.strictObject({ binDir: z.string(), shims: z.array(shim) }),
  annotations: { title: "List Role shims", readOnlyHint: true },
  async call(ctx: RolesContext) { return ctx.shims.list(); },
});
export const roleShimCreate = operation({
  name: "role_shim_create", description: "Install an executable Role injection shim in Stack's command directory; never replace a file or symlink. Supply ordered arguments after 'stack roles inject', including -- and a supported harness. Invocation arguments append unchanged. Native options are checked at launch, not configuration. Roles resolve at launch. Requires an installed Stack checkout and command directory.",
  input: z.strictObject({ name: shimName, args: shimArgs }), output: shim,
  annotations: { title: "Install Role shim" },
  async call(ctx: RolesContext, { name, args }) { const result = ctx.shims.create(name, args); ctx.shimsChanged?.(); return result; },
});
export const roleShimUpdate = operation({
  name: "role_shim_update", description: "Replace exactly one Stack-owned shim if its installed script still matches the listed revision. Never adopts unrelated or edited commands. Existing processes keep their launch snapshot.",
  input: z.strictObject({ name: shimName, expectedRevision: shimRevision, args: shimArgs }), output: shim,
  annotations: { title: "Update Role shim" },
  async call(ctx: RolesContext, { name, expectedRevision, args }) { const result = ctx.shims.update(name, expectedRevision, args); ctx.shimsChanged?.(); return result; },
});
export const roleShimDelete = operation({
  name: "role_shim_delete", description: "Remove only a Stack-owned Role shim at the listed revision. Does not delete a Role, an unrelated command, or a running session.",
  input: z.strictObject({ name: shimName, expectedRevision: shimRevision }), output: z.strictObject({ name: shimName }),
  annotations: { title: "Remove Role shim", destructiveHint: true },
  async call(ctx: RolesContext, { name, expectedRevision }) { ctx.shims.delete(name, expectedRevision); ctx.shimsChanged?.(); return { name }; },
});
export const categoryCreate = operation({
  name: "category_create", description: "Create an ordered category at the end of the role. Pass the current revision.",
  input: write.extend({ title, description: description.optional(), enabled: z.boolean().optional() }), output: receipt,
  annotations: { title: "Create category" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.role(input.roleId).createCategory(input.expectedRevision, input.title, input.description, input.enabled)); },
});
export const categoryUpdate = operation({
  name: "category_update", description: "Update a category's title, human-only description, or enabled state. A disabled category contributes no fragments.",
  input: write.extend({ id, title: title.optional(), description: description.optional(), enabled: z.boolean().optional() }), output: receipt,
  annotations: { title: "Update category" },
  async call(ctx: RolesContext, { roleId, id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.role(roleId).updateCategory(expectedRevision, id, fields)); },
});
export const categoryDelete = operation({
  name: "category_delete", description: "Delete an empty category. Move or delete its fragments first; no implicit content deletion.",
  input: write.extend({ id }), output: receipt, annotations: { title: "Delete category", destructiveHint: true },
  async call(ctx: RolesContext, { roleId, id, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).deleteCategory(expectedRevision, id)); },
});
export const categoryReorder = operation({
  name: "category_reorder", description: "Atomically replace category order with an exact permutation of all category IDs.",
  input: write.extend({ ids: z.array(id) }), output: receipt, annotations: { title: "Reorder categories" },
  async call(ctx: RolesContext, { roleId, ids, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).reorderCategories(expectedRevision, ids)); },
});
export const fragmentCreate = operation({
  name: "fragment_create", description: "Create a fragment at the end of a category, or at index. Only enabled nonblank bodies in enabled categories whose conditions all match render. Omitted conditions are unconditional.",
  input: write.extend({ categoryId: id, title, body, description: description.optional(), enabled: z.boolean().optional(), index: index.optional(), conditions: fragmentConditions.optional() }), output: receipt,
  annotations: { title: "Create instruction fragment" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.role(input.roleId).createFragment(input.expectedRevision, input.categoryId, input.title, input.body, input.description, input.enabled, input.index, input.conditions)); },
});
export const fragmentUpdate = operation({
  name: "fragment_update", description: "Update content or metadata, enable/disable, or move to another category (appended there). Conditions replace the whole condition object; {} clears them; omission preserves them. Reorder separately if needed.",
  input: write.extend({ id, categoryId: id.optional(), title: title.optional(), body: body.optional(), description: description.optional(), enabled: z.boolean().optional(), conditions: fragmentConditions.optional() }), output: receipt,
  annotations: { title: "Update instruction fragment" },
  async call(ctx: RolesContext, { roleId, id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.role(roleId).updateFragment(expectedRevision, id, fields)); },
});
export const fragmentDelete = operation({
  name: "fragment_delete", description: "Delete a fragment from its category and the role.",
  input: write.extend({ id }), output: receipt, annotations: { title: "Delete instruction fragment", destructiveHint: true },
  async call(ctx: RolesContext, { roleId, id, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).deleteFragment(expectedRevision, id)); },
});
export const fragmentReorder = operation({
  name: "fragment_reorder", description: "Atomically replace one category's fragment order with an exact permutation of its fragment IDs.",
  input: write.extend({ categoryId: id, ids: z.array(id) }), output: receipt, annotations: { title: "Reorder instruction fragments" },
  async call(ctx: RolesContext, { roleId, categoryId, ids, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).reorderFragments(expectedRevision, categoryId, ids)); },
});

export const fragmentMove = operation({
  name: "fragment_move", description: "Atomically place a fragment at a zero-based index of a category, its own or another. Index counts the destination's other fragments.",
  input: write.extend({ id, categoryId: id, index }), output: receipt, annotations: { title: "Move instruction fragment" },
  async call(ctx: RolesContext, { roleId, id, categoryId, index, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).moveFragment(expectedRevision, id, categoryId, index)); },
});

export const skillCreate = operation({
  name: "skill_create", description: "Add a role-owned skill. Stack generates SKILL.md frontmatter from the name and description; supporting files are private base64-encoded bytes. Only enabled skills enter later bot launches.",
  input: write.extend({ name: resourceName, description: resourceDescription.min(1), body: skillBody, files: skillFiles.optional(), enabled: z.boolean().optional() }),
  output: receipt, annotations: { title: "Create role skill" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.role(input.roleId).createSkill(input.expectedRevision, input.name, input.description, input.body, input.files, input.enabled)); },
});
export const skillUpdate = operation({
  name: "skill_update", description: "Edit skill name, description, Markdown body, supporting files, or enabled state. Supplying files replaces the complete supporting-file set.",
  input: write.extend({ id, name: resourceName.optional(), description: resourceDescription.min(1).optional(), body: skillBody.optional(), files: skillFiles.optional(), enabled: z.boolean().optional() }),
  output: receipt, annotations: { title: "Update role skill" },
  async call(ctx: RolesContext, { roleId, id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.role(roleId).updateSkill(expectedRevision, id, fields)); },
});
export const skillDelete = operation({
  name: "skill_delete", description: "Delete a role-owned skill and all its supporting files from future launches.",
  input: write.extend({ id }), output: receipt, annotations: { title: "Delete role skill", destructiveHint: true },
  async call(ctx: RolesContext, { roleId, id, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).deleteSkill(expectedRevision, id)); },
});
export const skillReorder = operation({
  name: "skill_reorder", description: "Atomically replace skill order with an exact permutation of all skill IDs.",
  input: write.extend({ ids: z.array(id) }), output: receipt, annotations: { title: "Reorder role skills" },
  async call(ctx: RolesContext, { roleId, ids, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).reorderSkills(expectedRevision, ids)); },
});

export const mcpServerCreate = operation({
  name: "mcp_server_create", description: "Add an HTTP or stdio MCP server to the role. It joins the server-provided internal MCP servers only on later bot launches.",
  input: write.extend({ name: resourceName, description: resourceDescription, definition: mcpDefinition, enabled: z.boolean().optional() }),
  output: receipt, annotations: { title: "Create role MCP server" },
  async call(ctx: RolesContext, input) {
    await ensureRoleMcp(ctx, input.name, input.definition);
    return changed(ctx, ctx.store.role(input.roleId).createMcpServer(input.expectedRevision, input.name, input.description, input.definition, input.enabled));
  },
});
export const mcpServerUpdate = operation({
  name: "mcp_server_update", description: "Edit a role MCP server's name, description, full transport definition, or enabled state. Existing bot connections are unchanged until restart.",
  input: write.extend({ id, name: resourceName.optional(), description: resourceDescription.optional(), definition: mcpDefinition.optional(), enabled: z.boolean().optional() }),
  output: receipt, annotations: { title: "Update role MCP server" },
  async call(ctx: RolesContext, { roleId, id, expectedRevision, ...fields }) {
    await ensureRoleMcp(ctx, fields.name, fields.definition);
    return changed(ctx, ctx.store.role(roleId).updateMcpServer(expectedRevision, id, fields));
  },
});
export const mcpServerDelete = operation({
  name: "mcp_server_delete", description: "Delete an additional role MCP server from later launches; internal server MCP connections are unaffected.",
  input: write.extend({ id }), output: receipt, annotations: { title: "Delete role MCP server", destructiveHint: true },
  async call(ctx: RolesContext, { roleId, id, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).deleteMcpServer(expectedRevision, id)); },
});
export const mcpServerReorder = operation({
  name: "mcp_server_reorder", description: "Atomically replace additional MCP server order with an exact permutation of their IDs.",
  input: write.extend({ ids: z.array(id) }), output: receipt, annotations: { title: "Reorder role MCP servers" },
  async call(ctx: RolesContext, { roleId, ids, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).reorderMcpServers(expectedRevision, ids)); },
});

export const projectCreate = operation({
  name: "project_create", description: "Allow bots launched inside this project root to load trusted project .codex configuration, including its MCP servers. Only later launches change.",
  input: write.extend({ path: projectPath, description: resourceDescription.optional(), enabled: z.boolean().optional() }),
  output: receipt, annotations: { title: "Trust project for bots" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.role(input.roleId).createTrustedProject(input.expectedRevision, input.path, input.description, input.enabled)); },
});
export const projectUpdate = operation({
  name: "project_update", description: "Edit a trusted project root, description, or enabled state. Disabling stops project config from entering later matching Bot launches.",
  input: write.extend({ id, path: projectPath.optional(), description: resourceDescription.optional(), enabled: z.boolean().optional() }),
  output: receipt, annotations: { title: "Update trusted project" },
  async call(ctx: RolesContext, { roleId, id, expectedRevision, ...fields }) { return changed(ctx, ctx.store.role(roleId).updateTrustedProject(expectedRevision, id, fields)); },
});
export const projectDelete = operation({
  name: "project_delete", description: "Remove a trusted project root from later Bot launches; running Bots keep their launch configuration.",
  input: write.extend({ id }), output: receipt, annotations: { title: "Remove trusted project", destructiveHint: true },
  async call(ctx: RolesContext, { roleId, id, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).deleteTrustedProject(expectedRevision, id)); },
});
export const projectReorder = operation({
  name: "project_reorder", description: "Atomically replace trusted project order with an exact permutation of all project IDs.",
  input: write.extend({ ids: z.array(id) }), output: receipt, annotations: { title: "Reorder trusted projects" },
  async call(ctx: RolesContext, { roleId, ids, expectedRevision }) { return changed(ctx, ctx.store.role(roleId).reorderTrustedProjects(expectedRevision, ids)); },
});

export const topics = { role_changed: "The role catalog, default, or any Role changed. Read roles_snapshot and refresh the selected Role after (re)subscribing.",
  role_shims_changed: "A Stack-owned Role shim was installed, updated or removed. Read role_shim_list after (re)subscribing; manual PATH edits do not publish notices." } as const;

const packageApi: PackageApi<RolesContext, keyof typeof topics> = {
  operations: [
    operation({ name: "role_launch_list", description: "Page metadata for exact retained Role-injection directories. Live launching PID/start identities block cleanup; missing/legacy locks and interrupted native teardown remain unknown. Bot/Worker materializations and external native histories are separate. Local operator only.",
      input: statePageInput, output: z.strictObject({ launches: z.array(z.strictObject({ id: launchId, state: z.enum(["live", "retained", "unknown"]), issue: z.string().nullable(), modifiedAt: z.string() })), revision: z.string(), nextOffset: z.number().int().nullable() }),
      annotations: { readOnlyHint: true }, async call(ctx: RolesContext, input, invocation) { requireStateOperator(invocation); return ctx.launches!.list(input); } }),
    operation({ name: "role_launch_plan", description: "Preview exact exited Role-injection directory cleanup. Binds directory identities and launch locks; live, unknown or symlink-bearing resources refuse cleanup. External native history, credentials, Bot/Worker materializations and Role configuration remain. Local operator only.",
      input: z.strictObject({ ids: z.array(launchId).min(1).max(100) }), output: statePlan, async call(ctx: RolesContext, { ids }, invocation) { requireStateOperator(invocation); return ctx.launches!.plan(ids); } }),
    operation({ name: "role_launch_clear", description: "Apply an exact launch plan after rechecking liveness and file identity. Persist admission before descriptor-relative removal; partial/quarantine or interrupted outcomes never rerun under the same request. No harness starts or stops implicitly. Local operator only.",
      input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true }, async call(ctx: RolesContext, input, invocation) { requireStateOperator(invocation); const result = await ctx.launches!.clear(input); ctx.changed?.(); return result; } }),
    operation({ name: "roles_state_receipt_get", description: "Read the durable receipt of exact retained Role launch cleanup, including partial or unknown outcomes. Local operator only.", input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: { readOnlyHint: true },
      async call(ctx: RolesContext, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.launches!.journal.receipt(requestId) }; } }),
    rolesSnapshot, roleCreate, roleUpdate, roleSetDefault, roleSetWorkerDefault, roleDelete, roleInternalMcpList, roleInternalMcpUpdate, roleSnapshot, roleLaunchSnapshot, roleEditorSnapshot, rolePreview, roleLaunchPreview,
    roleShimList, roleShimCreate, roleShimUpdate, roleShimDelete, categoryCreate, categoryUpdate, categoryDelete, categoryReorder,
    fragmentCreate, fragmentUpdate, fragmentDelete, fragmentReorder, fragmentMove, skillCreate, skillUpdate, skillDelete, skillReorder,
    mcpServerCreate, mcpServerUpdate, mcpServerDelete, mcpServerReorder,
    projectCreate, projectUpdate, projectDelete, projectReorder],
  events: {
    topics,
    start(ctx, publish) { ctx.changed = () => publish("role_changed"); ctx.shimsChanged = () => publish("role_shims_changed"); return () => { ctx.changed = undefined; ctx.shimsChanged = undefined; }; },
  },
  async createContext(env) {
    // The server serves MCP on its configured port; Bots also report the bound one.
    const ports = [mcpPort(env), Number(env.STACK_SERVER_MCP_PORT)].filter((port) => Number.isInteger(port) && port > 0);
    return { store: new RoleStore(env.STACK_STATE_DIR ?? join(homedir(), ".local", "state", "stack")), shims: new RoleShims(env), launches: new RoleLaunchState(stateDir(env)), mcpOrigins: ports.flatMap(serverMcpOrigins) };
  },
  async closeContext(ctx) { ctx.launches?.close(); ctx.store.close(); },
};
export const api = withStateInventory("roles", roleStateCategories, packageApi);
