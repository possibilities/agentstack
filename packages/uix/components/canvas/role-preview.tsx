"use client";

import { useEffect, useRef } from "react";
import { FileTextIcon } from "lucide-react";
import { approxTokens, fallbackLimitBytes, formatBytes, formatCount, previewBytes, previewPieces, roleLaunches } from "@/lib/stack/roles";
import { cn } from "@/lib/utils";
import { BotTile, CopyButton, Empty, Meter, NodeLink } from "./primitives";
import { useStack } from "./provider";
import { useRoleActions } from "./role-actions";
import { Section, Window } from "./window";

/**
 * Exactly what the next Bot launch appends, from `role_preview`, cut at each fragment's span. The text
 * itself is authoritative; fragment titles come from the Role and only label it.
 */
export function RolePreviewWindow() {
  const { role, rolePreview, bots, workerSessions, status, endpoints } = useStack();
  const actions = useRoleActions();
  const preview = rolePreview.data;
  const revision = role.data?.revision ?? preview?.revision ?? 0;
  const pieces = preview ? previewPieces(preview, role.data) : [];
  const bytes = preview ? previewBytes(preview) : 0;
  const limit = typeof preview?.limitBytes === "number" ? preview.limitBytes : fallbackLimitBytes;
  const used = Math.min(100, (bytes / limit) * 100);
  const updating = Boolean(preview && role.data && preview.revision !== role.data.revision);
  const launches = roleLaunches(bots.data, workerSessions.data, revision);
  const focused = actions.target?.kind === "fragment" ? actions.target.id : null;
  const list = useRef<HTMLOListElement>(null);

  // Keep the fragment being edited in view, scrolling only the window's own body.
  useEffect(() => {
    const item = focused ? list.current?.querySelector<HTMLElement>(`[data-segment="${focused}"]`) : null;
    const scroller = item?.closest<HTMLElement>("[data-scroll]");
    if (!item || !scroller) return;
    const top = item.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const scale = scroller.getBoundingClientRect().height / scroller.clientHeight || 1;
    if (top < 0 || top > scroller.getBoundingClientRect().height - 48) scroller.scrollTop += top / scale - 12;
  }, [focused, preview?.revision]);

  return (
    <Window id="role-preview" title="Preview" subtitle="SYSTEM_APPEND.md" icon={FileTextIcon} accent="roles"
      status={status.roles} endpoint={endpoints.roles} updatedAt={rolePreview.at} error={rolePreview.error} empty={!preview?.rendered}
      actions={preview?.rendered ? <CopyButton value={preview.rendered} label="rendered instructions" className="opacity-100" /> : undefined}>
      {preview ? (
        <div className="flex flex-col gap-1.5">
          <Meter value={100 - used} label="Share of the rendered size limit left" />
          <p role="status" className="flex items-center gap-1 px-0.5 text-[0.68rem] text-muted-foreground tabular-nums">
            <span>{formatBytes(bytes)} of {formatBytes(limit)} · ≈{formatCount(approxTokens(bytes))} tokens{pieces ? ` · ${pieces.length} fragment${pieces.length === 1 ? "" : "s"}` : ""}</span>
            <span className="ml-auto">{updating ? "Updating…" : `Revision ${preview.revision}`}</span>
          </p>
        </div>
      ) : null}
      {launches.bots.length || launches.workers.current + launches.workers.behind ? (
        <Section title="Launched" aside={<span className="text-[0.65rem] text-muted-foreground">Edits reach the next launch</span>}>
          <ul className="flex flex-col gap-1">
            {launches.bots.map(({ bot, current }) => (
              <li key={bot.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[0.78rem]">
                <BotTile bot={bot} className="size-6 rounded-md text-[0.7rem] [&_svg]:size-3" />
                <NodeLink node={{ kind: "bot", id: bot.id }} label={bot.id} className="font-mono text-[0.75rem]">{bot.id}</NodeLink>
                <span className="text-[0.68rem] text-muted-foreground tabular-nums">revision {bot.roleRevision}</span>
                <span className={cn("ml-auto rounded px-1.5 py-px text-[0.64rem] font-medium", current ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}
                  title={current ? "Launched with the current Role" : "Restart this Bot to give it the current Role"}>
                  {current ? "Current" : "Older role"}
                </span>
              </li>
            ))}
            {launches.workers.current + launches.workers.behind ? (
              <li className="px-1.5 py-1 text-[0.7rem] text-muted-foreground">
                {launches.workers.current + launches.workers.behind} open Worker{launches.workers.current + launches.workers.behind === 1 ? "" : "s"}
                {launches.workers.behind ? ` · ${launches.workers.behind} on an older role` : " · all current"}
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}
      {preview?.rendered && !pieces ? (
        <pre className="rounded-lg border bg-background/60 px-2.5 py-2 font-mono text-[0.72rem] leading-relaxed break-words whitespace-pre-wrap">{preview.rendered}</pre>
      ) : preview?.rendered && pieces ? (
        <ol ref={list} aria-label="Rendered instructions by fragment" className="flex flex-col gap-3">
          {pieces.map((piece, index) => (
            <li key={`${piece.fragmentId}:${index}`} data-segment={piece.fragmentId} className="flex flex-col gap-1">
              <button type="button" disabled={!piece.title} onClick={() => actions.open({ kind: "fragment", id: piece.fragmentId })}
                className={cn("flex items-center gap-1.5 self-start rounded-sm px-0.5 text-[0.66rem] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:hover:text-muted-foreground",
                  focused === piece.fragmentId && "text-pkg-roles hover:text-pkg-roles")}>
                <span className={cn("size-1.5 rounded-full bg-muted-foreground/40", focused === piece.fragmentId && "bg-pkg-roles")} />
                {piece.title ?? "Removed fragment"}
              </button>
              <pre className={cn("rounded-lg border bg-background/60 px-2.5 py-2 font-mono text-[0.72rem] leading-relaxed break-words whitespace-pre-wrap transition-colors",
                focused === piece.fragmentId && "border-pkg-roles/50 bg-pkg-roles/5")}>{piece.text}</pre>
            </li>
          ))}
        </ol>
      ) : (
        <Empty icon={FileTextIcon} title={preview ? "Nothing renders" : "Preview unavailable"} />
      )}
    </Window>
  );
}
