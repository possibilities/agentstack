/** Wire names checked against codexnk-v0.1.4 (f2905ff0), protocol.rs and v2/Thread.ts. */
export type RecordValue = Record<string, unknown>;
export const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const string = (value: unknown): string | null => typeof value === "string" ? value : null;
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const spawnSource = (source: unknown): RecordValue => object(object(object(source).subagent ?? object(source).subAgent).thread_spawn);

/** Conflicting or malformed parent claims fail closed, including older source-only metadata. */
export function parent(value: RecordValue, native = false): string | null | undefined {
  const explicit = value[native ? "parentThreadId" : "parent_thread_id"];
  const source = spawnSource(value.source).parent_thread_id;
  if (explicit != null && !uuid(explicit) || source != null && !uuid(source)) return undefined;
  if (explicit != null && source != null && explicit !== source) return undefined;
  return (explicit ?? source ?? null) as string | null;
}

/** Small summary only: prompts, instructions and arbitrary metadata stay in detail reads. */
export function historicalMetadata(meta: RecordValue): RecordValue {
  const spawn = spawnSource(meta.source);
  const summary: RecordValue = {};
  for (const [key, value] of Object.entries({
    sessionId: meta.session_id, forkedFromId: meta.forked_from_id,
    agentNickname: meta.agent_nickname ?? spawn.agent_nickname,
    agentRole: meta.agent_role ?? meta.agent_type ?? spawn.agent_role ?? spawn.agent_type,
    agentPath: meta.agent_path ?? spawn.agent_path,
    modelProvider: meta.model_provider, originator: meta.originator, cliVersion: meta.cli_version,
    historyMode: meta.history_mode, threadSource: meta.thread_source,
  })) if (typeof value === "string") { summary[key] = value.slice(0, 1024); if (value.length > 1024) summary.truncated = true; }
  if (typeof meta.source === "string") { summary.source = meta.source.slice(0, 1024); if (meta.source.length > 1024) summary.truncated = true; }
  else if (Object.keys(spawn).length) summary.source = "subAgentThreadSpawn";
  return summary;
}
