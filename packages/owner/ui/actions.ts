"use server";

import { ownerUiData } from "../dist/src/ui-source.js";
import type { TreeNode } from "./agent-tree";

export async function ownerTree(): Promise<TreeNode[]> {
  const data = ownerUiData();
  return [
    {
      kind: "manager",
      label: "owner",
      detail: data.pid ? `pid ${data.pid}` : "",
      activity: "working",
      children: data.children.map((child) => ({
        kind: "native",
        label: child.name,
        detail: child.pid ? `pid ${child.pid}` : "",
        activity: "working",
      })),
    },
  ];
}
