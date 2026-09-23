import type { ChildStatus } from "./owner.js";

export type OwnerUiData = {
  pid: number;
  children: ChildStatus[];
};

const key = "__agentstack_owner_ui_source__";

export function setOwnerUiSource(source: () => OwnerUiData): void {
  (globalThis as Record<string, unknown>)[key] = source;
}

export function ownerUiData(): OwnerUiData {
  const source = (globalThis as Record<string, unknown>)[key];
  return typeof source === "function" ? (source as () => OwnerUiData)() : { pid: process.pid, children: [] };
}
