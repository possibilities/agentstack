"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { clamp } from "@/lib/stack/geometry";

/** A nonmodal landmark, not a dialog: the bench stays reachable by keyboard. */
export function Dock({ side, label, open, overlay, width, min, max, onResize, onClose, returnFocus, restoreFocusOnHide = true, children }: {
  side: "left" | "right"; label: string; open: boolean; width: number; min: number; max: number;
  onResize(width: number): void; onClose(): void; children: React.ReactNode;
  returnFocus: React.RefObject<HTMLElement | null>;
  overlay: boolean;
  restoreFocusOnHide?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const hadFocus = useRef(false);
  const dragCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      returnTo.current = returnFocus.current;
      panel.current?.focus({ preventScroll: true });
    } else if (!open && wasOpen.current && restoreFocusOnHide && (hadFocus.current || panel.current?.contains(document.activeElement))) {
      if (returnTo.current?.isConnected && !returnTo.current.closest("[inert],[hidden]")) returnTo.current.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>(`[data-dock-trigger="${side}"]`)?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
    if (!open) hadFocus.current = false;
  }, [open, side, returnFocus, restoreFocusOnHide]);
  useEffect(() => () => dragCleanup.current?.(), []);
  return (
    <aside ref={panel} tabIndex={-1} aria-label={label} hidden={!open} inert={!open} data-chrome data-dock={side}
      onFocusCapture={() => { hadFocus.current = true; }}
      onBlurCapture={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false; }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !(event.target as Element).closest("[role=dialog],[role=alertdialog]")) {
          event.preventDefault(); event.stopPropagation(); onClose();
        }
      }}
      className={cn("fixed inset-y-0 z-40 flex max-w-full flex-col bg-popover text-popover-foreground outline-none", !open && "!hidden", side === "left" ? "left-0 border-r" : "right-0 border-l")}
      style={{ width: overlay ? "100%" : width }}>
      <div role="separator" hidden={overlay} tabIndex={0} aria-label={`Resize ${label}`} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)}
        className={cn("absolute inset-y-0 z-10 w-2 touch-none cursor-col-resize hover:bg-ring/20 focus-visible:bg-ring/30 focus-visible:outline-2 focus-visible:outline-ring", overlay && "hidden", side === "left" ? "-right-1" : "-left-1")}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16;
          const direction = side === "left" ? 1 : -1;
          const next = event.key === "Home" ? min : event.key === "End" ? max : event.key === "ArrowRight" ? width + step * direction : event.key === "ArrowLeft" ? width - step * direction : null;
          if (next !== null) { event.preventDefault(); onResize(clamp(next, min, max)); }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault(); event.currentTarget.focus();
          dragCleanup.current?.();
          const x = event.clientX;
          const move = (next: PointerEvent) => onResize(clamp(width + (next.clientX - x) * (side === "left" ? 1 : -1), min, max));
          const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); dragCleanup.current = null; };
          dragCleanup.current = stop;
          window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
        }} />
      {children}
    </aside>
  );
}

export function useDockSizes() {
  const [sizes, setSizes] = useState({ system: 352, inspector: 420, reference: 680 });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("agentstack.uix.docks.v1") ?? "{}");
      setSizes((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, typeof saved[key] === "number" && Number.isFinite(saved[key]) ? clamp(saved[key], 280, 1200) : value])) as typeof current);
    } catch { /* Unavailable storage never blocks the bench. */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => { try { localStorage.setItem("agentstack.uix.docks.v1", JSON.stringify(sizes)); } catch { /* optional persistence */ } }, 200);
    return () => clearTimeout(timer);
  }, [loaded, sizes]);
  return [sizes, setSizes] as const;
}
