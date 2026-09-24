import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configuredMcpPackages, operation, workspaceRoot, type PackageApi } from "@agentstack/api";
import { RoleStore, renderInstructions } from "./src/store.js";
import { mcpDefinition, mcpRecord, resourceName, resourceDescription, skillBody, skillFiles, skillRecord } from "./src/resources.js";

const id = z.uuid().describe("Stable category or fragment ID.");
const revision = z.number().int().nonnegative().describe("Expected role revision; stale writes fail.");
const title = z.string().trim().min(1).max(200);
const description = z.string().max(4_000);
const body = z.string().max(262_144).describe("Verbatim developer instruction body; metadata never renders.");
const fragment = z.strictObject({ id, categoryId: id, title, description, body, enabled: z.boolean() });
const category = z.strictObject({ id, title, description, enabled: z.boolean(), fragments: z.array(fragment) });
const snapshot = z.strictObject({ revision, categories: z.array(category), skills: z.array(skillRecord), mcpServers: z.array(mcpRecord) });
const preview = z.strictObject({ revision, rendered: z.string() });
const write = z.strictObject({ expectedRevision: revision });

export type RolesContext = { store: RoleStore; changed?: () => void };
function changed(ctx: RolesContext, result: z.infer<typeof snapshot>) { ctx.changed?.(); return result; }
async function ensureAdditionalMcpName(name: string): Promise<void> {
  const internal = await configuredMcpPackages(workspaceRoot(import.meta.dirname));
  if (internal.some((pkg) => pkg.name === name)) throw new Error(`role MCP server ${name} collides with an internal Package API`);
}

export const roleSnapshot = operation({
  name: "role_snapshot", description: "Read the single role's categories, fragments, order, enabled flags, and current revision.",
  input: z.strictObject({}), output: snapshot, annotations: { title: "Read role", readOnlyHint: true },
  async call(ctx: RolesContext) { return ctx.store.snapshot(); },
});
export const rolePreview = operation({
  name: "role_preview", description: "Preview the exact developer instruction text from the role for the next bot launch; descriptions and titles are excluded.",
  input: z.strictObject({}), output: preview, annotations: { title: "Preview role", readOnlyHint: true },
  async call(ctx: RolesContext) { const value = ctx.store.snapshot(); return { revision: value.revision, rendered: renderInstructions(value) }; },
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
  name: "fragment_create", description: "Create a fragment at the end of a category. Only enabled bodies in enabled categories render.",
  input: write.extend({ categoryId: id, title, body, description: description.optional(), enabled: z.boolean().optional() }), output: snapshot,
  annotations: { title: "Create instruction fragment" },
  async call(ctx: RolesContext, input) { return changed(ctx, ctx.store.createFragment(input.expectedRevision, input.categoryId, input.title, input.body, input.description, input.enabled)); },
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
    await ensureAdditionalMcpName(input.name);
    return changed(ctx, ctx.store.createMcpServer(input.expectedRevision, input.name, input.description, input.definition, input.enabled));
  },
});
export const mcpServerUpdate = operation({
  name: "mcp_server_update", description: "Edit a role MCP server's name, description, full transport definition, or enabled state. Existing bot connections are unchanged until restart.",
  input: write.extend({ id, name: resourceName.optional(), description: resourceDescription.optional(), definition: mcpDefinition.optional(), enabled: z.boolean().optional() }),
  output: snapshot, annotations: { title: "Update role MCP server" },
  async call(ctx: RolesContext, { id, expectedRevision, ...fields }) {
    if (fields.name) await ensureAdditionalMcpName(fields.name);
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

export const topics = { role_changed: "The role was edited. Read role_snapshot after (re)subscribing." } as const;

export const api: PackageApi<RolesContext, keyof typeof topics> = {
  operations: [roleSnapshot, rolePreview, categoryCreate, categoryUpdate, categoryDelete, categoryReorder,
    fragmentCreate, fragmentUpdate, fragmentDelete, fragmentReorder, skillCreate, skillUpdate, skillDelete, skillReorder,
    mcpServerCreate, mcpServerUpdate, mcpServerDelete, mcpServerReorder],
  events: {
    topics,
    start(ctx, publish) { ctx.changed = () => publish("role_changed"); return () => { ctx.changed = undefined; }; },
  },
  async createContext(env) { return { store: new RoleStore(env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack")) }; },
  async closeContext(ctx) { ctx.store.close(); },
};
