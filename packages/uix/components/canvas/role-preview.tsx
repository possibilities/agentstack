"use client";

import { useEffect, useRef, useState } from "react";
import { FileTextIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { approxTokens, fallbackLimitBytes, fallbackSnapshotLimit, formatBytes, formatCount, previewBytes, previewPieces, projectBots, roleLaunches } from "@/lib/stack/roles";
import type { RoleLaunchPreview } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { BotTile, CopyButton, Empty, Meter, NodeLink } from "./primitives";
import { useStack } from "./provider";
import { useRoleActions } from "./role-actions";
import { Section, Window } from "./window";

type View = "instructions" | "launch";
const resourceKinds = new Set(["skill", "mcp-server", "trusted-project", "new-skill", "new-mcp-server", "new-trusted-project"]);

/**
 * What the next Bot launch receives. Instructions: exactly what it appends, from `role_preview`, cut at each
 * fragment's span; fragment titles come from the Role and only label it. Launch: skills, MCP servers and
 * trusted projects from `role_launch_preview`.
 */
export function RolePreviewWindow() {
  const { role, rolePreview, roleLaunch, bots, workerSessions, status, endpoints } = useStack();
  const actions = useRoleActions();
  const [view, setView] = useState<View>("instructions");
  const editingResource = actions.target ? resourceKinds.has(actions.target.kind) : null;
  // Follow the editor: instruction records show the text, resource records show the launch.
  useEffect(() => { if (editingResource !== null) setView(editingResource ? "launch" : "instructions"); }, [editingResource]);
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

  const launched = launches.bots.length || launches.workers.current + launches.workers.behind ? (
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
  ) : null;
  const tabs = (
    <ToggleGroup value={[view]} onValueChange={(next: string[]) => { if (next.length) setView(next[0] as View); }} spacing={0} size="sm" variant="outline" aria-label="Preview" className="self-start">
      <ToggleGroupItem value="instructions">Instructions</ToggleGroupItem>
      <ToggleGroupItem value="launch">
        Launch
        {roleLaunch.data?.issues.length ? <span role="img" aria-label="Launch problems" className="size-1.5 rounded-full bg-destructive" /> : null}
      </ToggleGroupItem>
    </ToggleGroup>
  );

  if (view === "launch") {
    const launch = roleLaunch.data;
    return (
      <Window id="role-preview" title="Preview" subtitle="skills, MCP servers and trust" icon={FileTextIcon} accent="roles"
        status={status.roles} endpoint={endpoints.roles} updatedAt={roleLaunch.at} error={roleLaunch.error} empty={!launch}>
        {tabs}
        {launch ? <LaunchView launch={launch} updating={Boolean(role.data && launch.revision !== role.data.revision)} /> : <Empty icon={FileTextIcon} title="Launch preview unavailable" />}
        {launched}
      </Window>
    );
  }

  return (
    <Window id="role-preview" title="Preview" subtitle="SYSTEM_APPEND.md" icon={FileTextIcon} accent="roles"
      status={status.roles} endpoint={endpoints.roles} updatedAt={rolePreview.at} error={rolePreview.error} empty={!preview?.rendered}
      actions={preview?.rendered ? <CopyButton value={preview.rendered} label="rendered instructions" className="opacity-100" /> : undefined}>
      {tabs}
      {preview ? (
        <div className="flex flex-col gap-1.5">
          <Meter value={100 - used} label="Share of the rendered size limit left" />
          <p role="status" className="flex items-center gap-1 px-0.5 text-[0.68rem] text-muted-foreground tabular-nums">
            <span>{formatBytes(bytes)} of {formatBytes(limit)} · ≈{formatCount(approxTokens(bytes))} tokens{pieces ? ` · ${pieces.length} fragment${pieces.length === 1 ? "" : "s"}` : ""}</span>
            <span className="ml-auto">{updating ? "Updating…" : `Revision ${preview.revision}`}</span>
          </p>
        </div>
      ) : null}
      {launched}
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

const chip = "rounded-md px-1.5 py-0.5 font-mono text-[0.7rem]";

/** Everything but the instruction text that the next launch receives, as `role_launch_preview` reports it. */
function LaunchView({ launch, updating }: { launch: RoleLaunchPreview; updating: boolean }) {
  const { bots } = useStack();
  const actions = useRoleActions();
  const used = Math.min(100, (launch.snapshotChars / (launch.snapshotLimitChars || fallbackSnapshotLimit)) * 100);
  const open = (kind: "skill" | "mcp-server" | "trusted-project", id: string) => actions.open({ kind, id });
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Meter value={100 - used} label="Share of the Role size budget left" />
        <p role="status" className="flex items-center gap-1 px-0.5 text-[0.68rem] text-muted-foreground tabular-nums">
          <span>Role {formatCount(launch.snapshotChars)} of {formatCount(launch.snapshotLimitChars)} characters · {launch.instructions.fragments} fragment{launch.instructions.fragments === 1 ? "" : "s"}, {formatBytes(launch.instructions.bytes)}</span>
          <span className="ml-auto">{updating ? "Updating…" : `Revision ${launch.revision}`}</span>
        </p>
      </div>
      {launch.issues.length ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>New Bot launches fail</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {launch.issues.map((issue) => (
                <li key={issue.id}>
                  <button type="button" className="font-mono underline-offset-2 hover:underline" onClick={() => open("mcp-server", issue.id)}>{issue.name}</button>: {issue.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <Section title="Skills" aside={<span className="text-[0.65rem] text-muted-foreground">skills/&lt;name&gt;/SKILL.md</span>}>
        {launch.skills.length ? (
          <ul className="flex flex-col gap-0.5">
            {launch.skills.map((skill) => (
              <li key={skill.id}>
                <button type="button" onClick={() => open("skill", skill.id)} className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="font-mono text-[0.75rem] font-medium">{skill.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.7rem] text-muted-foreground">{skill.description}</span>
                  <span className="shrink-0 text-[0.64rem] text-muted-foreground tabular-nums">{skill.files ? `${skill.files} file${skill.files === 1 ? "" : "s"} · ` : ""}{formatBytes(skill.bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="px-1.5 text-[0.7rem] text-muted-foreground">No Role skills are enabled.</p>}
        <p className="px-1.5 text-[0.66rem] text-pretty text-muted-foreground">Bots also discover project and bundled skills; the Role adds to them.</p>
      </Section>
      <Section title="MCP servers" aside={<span className="text-[0.65rem] text-muted-foreground">{launch.internalMcpServers.length} internal · {launch.mcpServers.length} from the Role</span>}>
        <div className="flex flex-wrap gap-1 px-1.5">
          {launch.mcpServers.map((server) => (
            <button key={server.id} type="button" onClick={() => open("mcp-server", server.id)}
              className={cn(chip, "bg-pkg-roles/10 text-pkg-roles hover:bg-pkg-roles/20 focus-visible:outline-2 focus-visible:outline-ring")} title={`${server.type} · from the Role`}>
              {server.name}
            </button>
          ))}
          {launch.internalMcpServers.map((name) => <span key={name} className={cn(chip, "bg-muted text-muted-foreground")} title="Internal Package API, bound to each Bot at launch">{name}</span>)}
        </div>
        {launch.config ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 px-1.5">
              <span className="text-[0.66rem] text-muted-foreground">config.toml tables from the Role</span>
              <CopyButton value={launch.config} label="Role MCP config" className="opacity-100" />
            </div>
            <pre className="rounded-lg border bg-background/60 px-2.5 py-2 font-mono text-[0.7rem] leading-relaxed break-words whitespace-pre-wrap">{launch.config}</pre>
          </div>
        ) : null}
      </Section>
      <Section title="Trusted projects">
        {launch.trustedProjects.length ? (
          <ul className="flex flex-col gap-1">
            {launch.trustedProjects.map((project) => {
              const inside = projectBots(launch, project.id, bots.data);
              return (
                <li key={project.id} className="flex flex-col gap-0.5 rounded-md px-1.5 py-1">
                  <button type="button" onClick={() => open("trusted-project", project.id)} className="self-start truncate font-mono text-[0.72rem] hover:underline focus-visible:outline-2 focus-visible:outline-ring" title={project.path}>
                    {project.path}
                  </button>
                  <span className="flex flex-wrap items-center gap-1.5 text-[0.66rem] text-muted-foreground">
                    {inside.length ? inside.map((bot) => <NodeLink key={bot.id} node={{ kind: "bot", id: bot.id }} label={bot.id} className="font-mono text-[0.66rem]">{bot.id}</NodeLink>) : "No Bot runs inside it"}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <p className="px-1.5 text-[0.7rem] text-muted-foreground">No project is trusted; Bots load no project config.</p>}
      </Section>
    </>
  );
}
