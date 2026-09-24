import { socketCall, socketPath } from "@agentstack/api";
import { indexData, type Bot, type IndexData, type Owner } from "./index-data";

export type { Bot, Child, IndexData, Owner } from "./index-data";

export async function loadIndex(): Promise<IndexData> {
  const [ownerResult, botsResult] = await Promise.allSettled([
    socketCall(socketPath("owner"), "tools/call", { name: "owner_status", arguments: {} }, { timeoutMs: 1_500 }) as Promise<Owner>,
    socketCall(socketPath("bots"), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 1_500 }) as Promise<{ bots: Bot[] }>,
  ]);
  const owner = ownerResult.status === "fulfilled" ? ownerResult.value : null;
  return indexData(owner, botsResult.status === "fulfilled" ? botsResult.value.bots : null);
}
