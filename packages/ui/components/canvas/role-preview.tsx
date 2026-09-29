"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { FileTextIcon, GitBranchIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { approxTokens, conditionDimensions, conditionValueLimit, contextIssues, contextKey, contextSummary, fallbackLimitBytes, fallbackSnapshotLimit, formatBytes, formatCount, injectCommand, internalCounts, launchHint, normalizeContext, launchLabel, previewBytes, previewPieces, projectBots, roleLaunches, type LaunchState, type WorkerRoleState } from "@/lib/stack/roles";
import type { RoleLaunchPreview, RoleRenderContext } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { BotTile, CopyButton, Empty, Meter, NodeLink } from "./primitives";
import { useStack, useStore } from "./provider";
import { useRoleActions, useRoleView } from "./role-actions";
import { DefaultNote } from "./role-catalog";
import { Section, Window } from "./window";

type View = "instructions" | "launch";
const launchWord: Record<LaunchState, string> = { current: "Current", older: "Older revision", other: "Other Role", unknown: "Unknown" };
const launchTone: Record<LaunchState, string> = { current: "bg-success/15 text-success", older: "bg-warning/15 text-warning", other: "bg-muted text-muted-foreground", unknown: "bg-muted text-muted-foreground" };
/** Open Workers by how their captured Role relates to that same Role now; current and unavailable say nothing about change. */
const workerWords: Array<[WorkerRoleState, string, string]> = [["older", "on an older revision of its Role", "on older revisions of their Roles"],
  ["deleted", "with a deleted Role", "with deleted Roles"], ["unknown", "with an unknown legacy Role", "with unknown legacy Roles"], ["unavailable", "whose Role is not yet readable", "whose Roles are not yet readable"]];
const resourceKinds = new Set(["skill", "mcp-server", "trusted-project", "new-skill", "new-mcp-server", "new-trusted-project"]);

/**
 * What the next launch using this Role receives. Instructions: exactly what it appends, from `role_preview`, cut at
 * each fragment's span; fragment titles come from the Role and only label it. Launch: skills, MCP servers and
 * trusted projects from `role_launch_preview`. Bots and Workers both receive instructions, skills and MCP servers;
 * trusted projects configure Bots only.
 */
export function RolePreviewWindow() {
  const { role, rolePreview, roleLaunch, roleCatalog, roleContext, roleContextShown, bots, workerSessions, status, endpoints } = useStack();
  const actions = useRoleActions();
  const roleView = useRoleView();
  const [view, setView] = useState<View>("instructions");
  const editingResource = actions.target ? resourceKinds.has(actions.target.kind) : null;
  // Follow the editor: instruction records show the text, resource records show the launch.
  useEffect(() => { if (editingResource !== null) setView(editingResource ? "launch" : "instructions"); }, [editingResource]);
  const preview = rolePreview.data;
  const pieces = preview ? previewPieces(preview, role.data) : [];
  const bytes = preview ? previewBytes(preview) : 0;
  const limit = typeof preview?.limitBytes === "number" ? preview.limitBytes : fallbackLimitBytes;
  const used = Math.min(100, (bytes / limit) * 100);
  // Behind the Role's revision, or still answering an earlier rendering context.
  const current = contextKey(roleContext);
  const updating = Boolean(preview && ((role.data && preview.revision !== role.data.revision) || roleContextShown.rolePreview !== current));
  const launches = roleLaunches(bots.data, workerSessions.data, roleCatalog.data);
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

  const hint = (launch: Parameters<typeof launchHint>[0]) => launchHint(launch, roleView.defaultRole) ?? `Launched with ${launchLabel(launch)}, which is what a launch now would apply`;
  const differing = workerWords.flatMap(([state, one, many]) => launches.workers[state] ? [`${launches.workers[state]} ${launches.workers[state] === 1 ? one : many}`] : []).join(", ");
  const launched = launches.bots.length || launches.workers.total ? (
    <Section title="Launched" aside={<span className="text-[0.65rem] text-muted-foreground">Bots against the Bot default · Workers against their own Role</span>}>
      <ul className="flex flex-col gap-1">
        {launches.bots.map(({ bot, launch }) => (
          <li key={bot.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[0.78rem]">
            <BotTile bot={bot} className="size-6 rounded-md text-[0.7rem] [&_svg]:size-3" />
            <NodeLink node={{ kind: "bot", id: bot.id }} label={bot.id} className="font-mono text-[0.75rem]">{bot.id}</NodeLink>
            <span className="min-w-0 truncate text-[0.68rem] text-muted-foreground tabular-nums" title={hint(launch)}>{launchLabel(launch)}</span>
            <span className={cn("ml-auto shrink-0 rounded px-1.5 py-px text-[0.64rem] font-medium", launchTone[launch.state])} title={hint(launch)}>{launchWord[launch.state]}</span>
          </li>
        ))}
        {launches.workers.total ? (
          <li className="px-1.5 py-1 text-[0.7rem] text-muted-foreground" title="Each Worker keeps the Role snapshot it started with, whichever Role it selected; editing a Role changes no open Worker">
            {launches.workers.total} open Worker{launches.workers.total === 1 ? "" : "s"}{differing ? ` · ${differing}` : " · each on its Role’s current revision"}
          </li>
        ) : null}
      </ul>
    </Section>
  ) : null;
  const context = <RenderContext roleName={roleView.role?.name ?? null} />;
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
      <Window id="role-preview" title="Preview" subtitle={[roleView.label, "skills, MCP servers and trust"].filter(Boolean).join(" · ")} icon={FileTextIcon} accent="roles"
        status={status.roles} endpoint={endpoints.roles} updatedAt={roleLaunch.at} error={roleLaunch.error} empty={!launch}>
        <DefaultNote />
        {tabs}
        {context}
        {launch ? <LaunchView launch={launch} updating={Boolean((role.data && launch.revision !== role.data.revision) || roleContextShown.roleLaunch !== current)} /> : <Empty icon={FileTextIcon} title={roleView.blank ?? (roleLaunch.error ? "Launch preview unavailable" : "Reading launch…")} />}
        {launched}
      </Window>
    );
  }

  return (
    <Window id="role-preview" title="Preview" subtitle={[roleView.label, "SYSTEM_APPEND.md"].filter(Boolean).join(" · ")} icon={FileTextIcon} accent="roles"
      status={status.roles} endpoint={endpoints.roles} updatedAt={rolePreview.at} error={rolePreview.error} empty={!preview?.rendered}
      actions={preview?.rendered ? <CopyButton value={preview.rendered} label="rendered instructions" className="opacity-100" /> : undefined}>
      <DefaultNote />
      {tabs}
      {context}
      {preview ? (
        <div className="flex flex-col gap-1.5">
          <Meter value={100 - used} label="Share of the rendered size limit left" />
          <p role="status" className="flex items-center gap-1 px-0.5 text-[0.68rem] text-muted-foreground tabular-nums">
            <span>{formatBytes(bytes)} of {formatBytes(limit)} · ≈{formatCount(approxTokens(bytes))} tokens{pieces ? ` · ${pieces.length} fragment${pieces.length === 1 ? "" : "s"}` : ""}</span>
            <span className="ml-auto">{updating ? "Updating…" : `Revision ${preview.revision}`}</span>
          </p>
          <p className="px-0.5 text-[0.66rem] text-pretty text-muted-foreground">
            {contextSummary(roleContext)
              ? "What an injected launch with this context receives. Bots and Workers supply no context, so they receive the preview without it."
              : "Bots append this to SYSTEM_APPEND.md; Workers that use this Role receive it when they start."} Native and repository guidance still apply.
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
        <Empty icon={FileTextIcon} title={roleView.blank ?? (preview ? "Nothing renders" : rolePreview.error ? "Preview unavailable" : "Reading preview…")} />
      )}
    </Window>
  );
}

const chip = "rounded-md px-1.5 py-0.5 font-mono text-[0.7rem]";

/** Everything but the instruction text that the next launch receives, as `role_launch_preview` reports it. */
function LaunchView({ launch, updating }: { launch: RoleLaunchPreview; updating: boolean }) {
  const { bots, roleContext } = useStack();
  // The rendering context changes only the instruction count and size; skills, servers and trust never depend on it.
  const roleContextSummary = contextSummary(roleContext);
  const actions = useRoleActions();
  const used = Math.min(100, (launch.snapshotChars / (launch.snapshotLimitChars || fallbackSnapshotLimit)) * 100);
  const { on, total } = internalCounts(launch.internalMcpServers);
  const open = (kind: "skill" | "mcp-server" | "trusted-project", id: string) => actions.open({ kind, id });
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Meter value={100 - used} label="Share of the Role size budget left" />
        <p role="status" className="flex items-center gap-1 px-0.5 text-[0.68rem] text-muted-foreground tabular-nums">
          <span>Role {formatCount(launch.snapshotChars)} of {formatCount(launch.snapshotLimitChars)} characters · {launch.instructions.fragments} fragment{launch.instructions.fragments === 1 ? "" : "s"}, {formatBytes(launch.instructions.bytes)}{roleContextSummary ? ` with ${roleContextSummary}` : ""}</span>
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
        <p className="px-1.5 text-[0.66rem] text-pretty text-muted-foreground">Bots and Workers that use this Role receive these skills, alongside any project and bundled skills they discover.</p>
      </Section>
      <Section title="MCP servers" aside={<span className="text-[0.65rem] text-muted-foreground tabular-nums">{on} of {total} Stack server{total === 1 ? "" : "s"} on · {launch.mcpServers.length} from the Role</span>}>
        <div className="flex flex-wrap gap-1 px-1.5">
          {launch.mcpServers.map((server) => (
            <button key={server.id} type="button" onClick={() => open("mcp-server", server.id)}
              className={cn(chip, "bg-pkg-roles/10 text-pkg-roles hover:bg-pkg-roles/20 focus-visible:outline-2 focus-visible:outline-ring")} title={`${server.type} · from the Role`}>
              {server.name}
            </button>
          ))}
          {launch.internalMcpServers.map((server) => server.enabled
            ? <span key={server.name} className={cn(chip, "bg-muted text-muted-foreground")} title="Stack server, bound to each launch">{server.name}</span>
            : <span key={server.name} className={cn(chip, "bg-muted/40 text-muted-foreground/70 line-through")} title="Off for this Role">{server.name}<span className="sr-only"> (off for this Role)</span></span>)}
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
        <p className="px-1.5 text-[0.66rem] text-pretty text-muted-foreground">Bots only. Workers that use this Role get no native project trust from these records.</p>
      </Section>
    </>
  );
}

/** How long typing waits before the previews are reread with a new context. */
const contextDelay = 300;

/**
 * The rendering context both previews use. Editing it only rereads the previews: it changes nothing in the Role and
 * configures no runtime. Values commit after a pause, or at once on Enter or leaving the field; an invalid one is
 * never sent.
 */
function RenderContext({ roleName }: { roleName: string | null }) {
  const store = useStore();
  const { roleContext } = useStack();
  const [draft, setDraft] = useState<RoleRenderContext>(roleContext);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const issues = contextIssues(draft);
  const valid = !Object.keys(issues).length;
  const commit = (next: RoleRenderContext) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!Object.keys(contextIssues(next)).length) store.setRoleContext(next);
  };
  const change = (next: RoleRenderContext) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(next), contextDelay);
  };
  // Leaving with a pause still running applies what was typed rather than dropping it.
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    if (!Object.keys(contextIssues(latest.current)).length) store.setRoleContext(latest.current);
  }, [store]);
  const summary = contextSummary(roleContext);
  const pending = contextKey(draft) !== contextKey(roleContext);
  return (
    <section aria-labelledby="role-render-context" className="flex flex-col gap-1.5 rounded-xl border bg-background/50 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <GitBranchIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <h3 id="role-render-context" className="text-[0.74rem] font-medium">Rendering context</h3>
        <span className="text-[0.66rem] text-muted-foreground">{pending && valid ? "Applying…" : summary ? "preview only" : "none"}</span>
        {Object.keys(draft).length ? (
          <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => { setDraft({}); commit({}); }}>Clear</Button>
        ) : null}
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1">
        {conditionDimensions.map(({ key, label }) => {
          const value = draft[key] ?? "";
          const set = (text: string) => normalizeContext({ ...draft, [key]: text });
          return (
            <Fragment key={key}>
              <label htmlFor={`role-context-${key}`} className="text-[0.7rem] text-muted-foreground">{label}</label>
              <InputGroup className="h-7">
                <InputGroupInput id={`role-context-${key}`} value={value} maxLength={conditionValueLimit} placeholder="Not set" autoComplete="off" spellCheck={false}
                  aria-invalid={issues[key] ? true : undefined} aria-describedby={issues[key] ? `role-context-${key}-issue` : "role-context-hint"}
                  onChange={(event) => change(set(event.target.value))} onBlur={() => commit(draft)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(draft); } }} className="font-mono text-[0.74rem]" />
                {value ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" aria-label={`Clear ${label.toLowerCase()} context`} onClick={() => { const next = set(""); setDraft(next); commit(next); }}><XIcon /></InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
              {issues[key] ? <p id={`role-context-${key}-issue`} className="col-start-2 px-0.5 text-[0.66rem] text-destructive">{issues[key]}</p> : null}
            </Fragment>
          );
        })}
      </div>
      <p id="role-context-hint" className="px-0.5 text-[0.66rem] text-pretty text-muted-foreground">
        {summary
          ? "Shows the fragments whose conditions match exactly, letter case included. This changes nothing in the Role and configures no native runtime; the native command's own model flag is never read."
          : "Without context, only unconditional fragments render. This is what Bots and Workers receive today, since they supply no context."}
      </p>
      {summary ? (
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem]" title="Only the with- flags supply context; they add no native arguments">{injectCommand(roleName, roleContext)} &lt;cli&gt; …</code>
          <CopyButton value={`${injectCommand(roleName, roleContext)} `} label="inject command" className="opacity-100" />
        </div>
      ) : null}
    </section>
  );
}
