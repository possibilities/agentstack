"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { codexTree } from "./actions";

export type TreeNode = {
  kind: "manager" | "native";
  label: string;
  detail?: string;
  activity: "working" | "waiting" | "idle" | "failed" | "unknown";
  children?: TreeNode[];
};

const managerIcon = (
  <svg className="tree-kind-icon" data-icon="manager" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 6v3m-2.5 4.5-4 3m9-3 4 3" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
    <circle cx="12" cy="3.5" r="2" fill="currentColor" />
    <circle cx="4" cy="18" r="2" fill="currentColor" />
    <circle cx="20" cy="18" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="0.75" stroke="none" fill="var(--canvas)" />
  </svg>
);
const robotIcon = (
  <svg className="tree-kind-icon" data-icon="robot" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 3v4M1 12v4m22-4v4" />
    <rect x="3" y="7" width="18" height="13" rx="3" fill="currentColor" />
    <circle cx="8" cy="12" r="1" stroke="var(--canvas)" />
    <circle cx="16" cy="12" r="1" stroke="var(--canvas)" />
    <path d="M9 17h6" stroke="var(--canvas)" />
  </svg>
);

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <li className="tree-item">
      <div
        className="tree-row"
        tabIndex={0}
        role="group"
        data-kind={node.kind}
        data-activity={node.activity}
        data-depth={depth}
        data-has-metadata={node.detail ? "true" : undefined}
        style={{ "--depth": String(Math.min(depth, 12)) } as CSSProperties}
        aria-label={`${node.label}; ${node.activity}`}
        title={node.label}
      >
        <span className={`tree-status tree-status--${node.activity}`}>
          {node.kind === "manager" ? managerIcon : robotIcon}
        </span>
        <span className="tree-heading">
          <span className="tree-label">{node.label}</span>
        </span>
        {node.detail ? (
          <span className="tree-settings" data-agent="true" role="note">
            <span className="tree-agent-settings">{node.detail}</span>
          </span>
        ) : null}
      </div>
      {node.children?.length ? (
        <ul className="tree-children">
          {node.children.map((child) => (
            <Row key={child.label} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function onTreeKeyDown(event: KeyboardEvent<HTMLUListElement>) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".tree-row"));
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const target =
    event.key === "Home"
      ? rows[0]
      : event.key === "End"
        ? rows.at(-1)
        : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

function AgentTree({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul className="active-tree" aria-label="Agents" onKeyDown={onTreeKeyDown}>
      {nodes.map((node) => (
        <Row key={node.label} node={node} depth={0} />
      ))}
    </ul>
  );
}

export function CodexTree({ initial }: { initial: TreeNode[] | null }) {
  const [nodes, setNodes] = useState<TreeNode[] | null>(initial);
  const busy = useRef(false);
  useEffect(() => {
    let live = true;
    const paint = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const fast = await codexTree(false);
        if (live) setNodes(fast);
        const full = await codexTree(true);
        if (live) setNodes(full);
      } catch {
        if (live) setNodes((current) => (current && current.length > 0 ? current : null));
      } finally {
        busy.current = false;
      }
    };
    const timer = setInterval(() => void paint(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (nodes === null) return <p role="status">Unavailable</p>;
  if (nodes.length === 0) return <p role="status">No running agents</p>;
  return <AgentTree nodes={nodes} />;
}
