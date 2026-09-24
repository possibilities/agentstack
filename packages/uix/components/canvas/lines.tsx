"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { nodeKey } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { accountColor } from "./primitives";
import { useStack, useWorkbench } from "./provider";

type Edge = { id: string; from: string; to: string; color: string; dashed?: boolean };
type Geometry = Edge & { d: string; start: [number, number]; end: [number, number] };

function useEdges(): Edge[] {
  const { bots } = useStack();
  return useMemo(() => {
    const edges: Edge[] = [];
    for (const bot of bots.data ?? []) {
      if (bot.account) edges.push({ id: `${bot.id}>${bot.account}`, from: `bot:${bot.id}`, to: `account:${bot.account}`, color: accountColor(bot.account) });
      if (bot.state === "running" && bot.runningAccount && bot.runningAccount !== bot.account) {
        edges.push({ id: `${bot.id}>>${bot.runningAccount}`, from: `bot:${bot.id}`, to: `account:${bot.runningAccount}`, color: "var(--warning)", dashed: true });
      }
    }
    return edges;
  }, [bots.data]);
}

/**
 * Relationship curves between cards in different windows. Each end leaves
 * its window's edge at the card's vertical center.
 */
export function Lines({ world, scale, version, animating, subtle }: {
  world: HTMLElement | null;
  scale: number;
  version: unknown;
  animating: boolean;
  subtle: boolean;
}) {
  const edges = useEdges();
  const { hovered, selected } = useWorkbench();
  const [paths, setPaths] = useState<Geometry[]>([]);

  const compute = useCallback(() => {
    if (!world) return;
    const origin = world.getBoundingClientRect();
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: (rect.left - origin.left) / scale, right: (rect.right - origin.left) / scale, top: (rect.top - origin.top) / scale, bottom: (rect.bottom - origin.top) / scale };
    };
    const anchor = (key: string) => {
      const node = world.querySelector(`[data-node="${CSS.escape(key)}"]`);
      const frame = node?.closest("[data-window]");
      if (!node || !frame) return null;
      const card = box(node);
      const win = box(frame);
      const y = Math.min(Math.max((card.top + card.bottom) / 2, win.top + 24), win.bottom - 12);
      return { left: win.left, right: win.right, y, window: frame };
    };
    const next: Geometry[] = [];
    for (const edge of edges) {
      const a = anchor(edge.from);
      const b = anchor(edge.to);
      if (!a || !b || a.window === b.window) continue;
      let sx: number, ex: number, bend: number;
      if (a.left >= b.right) { sx = a.left; ex = b.right; bend = -1; }
      else if (a.right <= b.left) { sx = a.right; ex = b.left; bend = 1; }
      else { sx = a.right; ex = b.right; bend = 0; }
      const reach = bend === 0 ? 56 : Math.max(48, Math.abs(ex - sx) / 2);
      const c1 = bend === 0 ? sx + reach : sx + reach * bend;
      const c2 = bend === 0 ? ex + reach : ex - reach * bend;
      next.push({ ...edge, d: `M ${sx} ${a.y} C ${c1} ${a.y}, ${c2} ${b.y}, ${ex} ${b.y}`, start: [sx, a.y], end: [ex, b.y] });
    }
    setPaths(next);
  }, [world, edges, scale]);

  useLayoutEffect(compute, [compute, version]);

  useEffect(() => {
    if (!world) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(compute);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(world);
    for (const element of world.querySelectorAll("[data-window]")) observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [world, compute, version]);

  useEffect(() => {
    if (!animating) return;
    let frame = requestAnimationFrame(function tick() {
      compute();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [animating, compute]);

  const focus = new Set([hovered, selected ? nodeKey(selected) : null].filter(Boolean));

  const tone = (path: Geometry) => {
    const lit = focus.has(path.from) || focus.has(path.to);
    return { lit, className: cn("transition-opacity duration-300", lit ? "opacity-100" : subtle ? "opacity-0" : "opacity-60") };
  };

  // Curves pass beneath windows; their end dots sit above window borders.
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute top-0 left-0 size-px overflow-visible">
        {paths.map((path) => {
          const { lit, className } = tone(path);
          return (
            <g key={path.id} style={{ color: path.color }} className={className}>
              <path d={path.d} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={lit ? 8 : 0} strokeLinecap="round" />
              <path d={path.d} fill="none" stroke="currentColor" strokeWidth={lit ? 2 : 1.5} strokeLinecap="round"
                strokeDasharray={path.dashed || lit ? "6 6" : undefined} className={lit ? "animate-uix-flow" : undefined} />
            </g>
          );
        })}
      </svg>
      <svg aria-hidden className="pointer-events-none absolute top-0 left-0 z-[100] size-px overflow-visible">
        {paths.map((path) => (
          <g key={path.id} style={{ color: path.color }} className={tone(path).className}>
            <circle cx={path.start[0]} cy={path.start[1]} r={3.5} fill="var(--card)" stroke="currentColor" strokeWidth={1.75} />
            <circle cx={path.end[0]} cy={path.end[1]} r={3.5} fill="currentColor" stroke="var(--card)" strokeWidth={1.5} />
          </g>
        ))}
      </svg>
    </>
  );
}
