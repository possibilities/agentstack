"use client";

import type { BrainSensitivity } from "@/lib/stack/types";
import { snippetParts } from "@/lib/stack/brain";
import { cn } from "@/lib/utils";

export const badge = "rounded-md bg-muted px-1.5 py-px text-[0.64rem] text-muted-foreground";

/** Why Brain controls can't run here, or null when they can. */
export function brainUnavailable(endpoints: Record<string, string>, status: Record<string, string>): string | null {
  return !endpoints.brain ? "Brain isn't served by this server" : status.brain !== "open" ? "Brain reconnecting" : null;
}

/** Normal is the default and stays unmarked; other policies are named, never shown by color alone. */
export function SensitivityBadge({ value }: { value: BrainSensitivity | string }) {
  if (value === "normal") return null;
  return (
    <span className={cn(badge, value === "private" || value === "sensitive" ? "bg-warning/15 text-warning" : "")} title={`Sensitivity: ${value}`}>
      {value}
    </span>
  );
}

export function Snippet({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn("line-clamp-3 text-[0.72rem] text-pretty break-words text-muted-foreground", className)}>
      {snippetParts(text).map((part, index) => part.match
        ? <mark key={index} className="rounded-[2px] bg-pkg-brain/20 px-px text-foreground">{part.text}</mark>
        : <span key={index}>{part.text}</span>)}
    </p>
  );
}

export function TagList({ tags, onPick, limit = 6 }: { tags: string[]; onPick?(tag: string): void; limit?: number }) {
  if (!tags.length) return null;
  const shown = tags.slice(0, limit);
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {shown.map((tag) => onPick
        ? <button key={tag} type="button" className={cn(badge, "hover:bg-muted-foreground/15 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring")} title={`Filter by ${tag}`} onClick={() => onPick(tag)}>#{tag}</button>
        : <span key={tag} className={badge}>#{tag}</span>)}
      {tags.length > shown.length ? <span className="text-[0.64rem] text-muted-foreground">+{tags.length - shown.length}</span> : null}
    </span>
  );
}
