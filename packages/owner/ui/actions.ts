"use server";

import { ownerUiData } from "../dist/src/ui-source.js";
import type { ChildStatus } from "../src/owner";
import type { TreeNode } from "./agent-tree";

export async function ownerEventsUrl(): Promise<string | null> {
  return ownerUiData().websocketUrl ?? null;
}

export async function ownerTree(): Promise<TreeNode[]> {
  const data = ownerUiData();
  return [
    {
      id: "owner",
      kind: "manager",
      label: "owner",
      detail: data.pid ? `pid ${data.pid}` : "",
      activity: "working",
      children: data.children.map((child: ChildStatus) => ({
        id: child.name,
        kind: "native",
        label: child.name,
        detail: child.running ? `pid ${child.pid}` : child.error ?? (child.signal ? `stopped by ${child.signal}` : `exited ${child.exitCode ?? "unknown"}`),
        activity: child.running ? "working" : "failed",
      })),
    },
  ];
}
