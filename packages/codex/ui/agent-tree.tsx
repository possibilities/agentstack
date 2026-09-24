"use client";

import type { CSSProperties } from "react";
import { cva } from "class-variance-authority";
import { usePubsub } from "@agentstack/api/ui/use-pubsub";

export type TreeNode = {
  id: string;
  kind: "manager" | "native";
  label: string;
  detail?: string;
  activity: "working" | "waiting" | "idle" | "failed" | "unknown";
  children?: TreeNode[];
};

const treeRow = cva(
  "relative isolate grid w-full min-w-0 cursor-default grid-cols-[20px_minmax(0,1fr)_var(--action-rail)] grid-rows-[var(--action-size)] items-center gap-x-[var(--row-gap)] py-1 pr-1 pl-[calc(8px+var(--depth,0)*24px)] text-left text-lg leading-[26px] text-foreground has-focus-visible:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus max-[480px]:pl-[calc(4px+min(var(--depth,0),6)*14px)] max-[480px]:text-base max-[480px]:[--row-gap:10px]",
  {
    variants: {
      kind: { manager: "", native: "" },
      metadata: {
        true: "grid-rows-[var(--action-size)_20px] items-start min-h-16",
        false: "min-h-[calc(var(--action-size)+8px)]",
      },
    },
    compoundVariants: [{ kind: "native", class: "hover:bg-surface focus-visible:bg-surface" }],
  },
);

const treeStatus = cva(
  "pointer-events-none relative col-start-1 row-start-1 inline-flex h-9 items-center justify-center",
  {
    variants: {
      activity: {
        working: "text-positive",
        waiting: "text-warning",
        idle: "text-muted-foreground",
        failed: "text-negative",
        unknown: "text-warning",
      },
    },
  },
);

const treeLabel = cva("min-w-0 truncate", {
  variants: { kind: { manager: "font-[550]", native: "" } },
});

const managerIcon = (
  <svg data-icon="manager" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="size-5 shrink-0">
    <path d="M12 6v3m-2.5 4.5-4 3m9-3 4 3" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
    <circle cx="12" cy="3.5" r="2" fill="currentColor" />
    <circle cx="4" cy="18" r="2" fill="currentColor" />
    <circle cx="20" cy="18" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="0.75" stroke="none" className="fill-background" />
  </svg>
);
const robotIcon = (
  <svg data-icon="robot" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="size-5 shrink-0">
    <path d="M12 3v4M1 12v4m22-4v4" />
    <rect x="3" y="7" width="18" height="13" rx="3" fill="currentColor" />
    <circle cx="8" cy="12" r="1" className="fill-background" />
    <circle cx="16" cy="12" r="1" className="fill-background" />
    <path d="M9 17h6" className="stroke-background" />
  </svg>
);

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <li className="list-none">
      <div
        className={treeRow({ kind: node.kind, metadata: Boolean(node.detail) })}
        data-slot="tree-row"
        data-kind={node.kind}
        data-activity={node.activity}
        data-depth={depth}
        style={{ "--depth": String(Math.min(depth, 12)) } as CSSProperties}
        title={node.label}
      >
        <span data-slot="tree-status" className={treeStatus({ activity: node.activity })}>
          {node.kind === "manager" ? managerIcon : robotIcon}
        </span>
        <span data-slot="tree-heading" className="pointer-events-none relative col-start-2 row-start-1 flex h-9 min-w-0 items-center gap-2">
          <span className={treeLabel({ kind: node.kind })}>{node.label}</span>
          <span className="sr-only">{node.activity}</span>
        </span>
        <span className="col-start-3 row-start-1 text-[13px] text-muted-foreground">{node.activity}</span>
        {node.detail ? (
          <span data-slot="tree-settings" role="note" className="pointer-events-none relative col-start-2 row-start-2 flex h-5 w-full max-w-full min-w-0 items-baseline gap-1 truncate text-[13px]/5 text-muted-foreground tabular-nums">
            <span className="min-w-0 truncate">{node.detail}</span>
          </span>
        ) : null}
      </div>
      {node.children?.length ? (
        <ul className="m-0 list-none p-0">
          {node.children.map((child) => (
            <Row key={child.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AgentTree({ nodes }: { nodes: TreeNode[] }) {
  const counts = { working: 0, waiting: 0, failed: 0 };
  const count = (items: TreeNode[]) => {
    for (const item of items) {
      if (item.activity in counts) counts[item.activity as keyof typeof counts] += 1;
      count(item.children ?? []);
    }
  };
  count(nodes);
  return (
    <>
      <p className="sr-only" aria-live="polite">{`${counts.working} working, ${counts.waiting} waiting, ${counts.failed} failed`}</p>
      <ul className="m-0 list-none p-0" aria-label="Agents">
        {nodes.map((node) => <Row key={node.id} node={node} depth={0} />)}
      </ul>
    </>
  );
}

export function CodexTree({ initial, eventsUrl, emptyLabel = "No running agents" }: { initial: TreeNode[] | null; eventsUrl: string | null; emptyLabel?: string }) {
  usePubsub(eventsUrl, ["servers_changed", "threads_changed"]);
  const nodes = initial;
  if (nodes === null) return <p role="status" className="m-2 text-base text-muted-foreground">Unavailable</p>;
  if (nodes.length === 0) return <p role="status" className="m-2 text-base text-muted-foreground">{emptyLabel}</p>;
  return <AgentTree nodes={nodes} />;
}
