"use client";

import { ActivityIcon, BellIcon, CalendarClockIcon, ChartGanttIcon, HammerIcon, BlocksIcon, BotIcon, BoxesIcon, EyeIcon, LibraryIcon, NotebookTextIcon, ChartLineIcon, CpuIcon, FilePenLineIcon, FileTextIcon, FlaskConicalIcon, FolderLockIcon, GaugeIcon, HistoryIcon, InboxIcon, KeyRoundIcon, ListTreeIcon, MegaphoneIcon, MessageSquareWarningIcon, MessagesSquareIcon, PackageIcon, PlugIcon, RadarIcon, RadioIcon, ScanLineIcon, ScrollTextIcon, ServerIcon, SparklesIcon, SquareTerminalIcon, UserCogIcon, UsersRoundIcon } from "lucide-react";
import type { ChatWindows } from "@/lib/stack/chat-windows";
import type { WorkerWindows } from "@/lib/stack/worker-windows";
import type { ViewerWindows } from "@/lib/stack/browse-viewers";
import type { ProcRunWindows } from "@/lib/stack/proc-windows";
import { CableIcon, DatabaseIcon, HardDriveIcon, LifeBuoyIcon, MonitorIcon, WrenchIcon } from "lucide-react";
import { HandoffsWindow, ViewerWindow } from "./browse-handoffs";
import { ControllersWindow, ProfilesWindow, ToolchainWindow } from "./browse-operator";
import { ArrowRightLeftIcon, FolderInputIcon, GlobeIcon, ListChecksIcon, RssIcon } from "lucide-react";
import { ExtractWindow } from "./scrape-extract";
import { ConvertWindow, FeedsWindow } from "./scrape-feeds";
import { ChecksWindow, PresetsWindow, QueueWindow, StatusWindow } from "./scrape-operator";
import { BookOpenTextIcon, BrainIcon, ImportIcon, SatelliteDishIcon, SearchIcon } from "lucide-react";
import { ReaderWindow, SearchWindow } from "./brain-search";
import { IngestWindow } from "./brain-ingest";
import { JobsWindow, SourcesWindow } from "./brain-ledger";
import type { SpaceId } from "@/lib/stack/spaces";
import type { StackState } from "@/lib/stack/store";
import { type Accent } from "./window";
import { AccountsWindow, BotsWindow } from "./windows";
import { UsageWindow } from "./usage-window";
import { CatalogWindow } from "./catalog-window";
import { CallSpeechWindow } from "./call-speech-window";
import { InferenceWindow } from "./inference-window";
import { HostWindow, ProcessesWindow, ResourcesWindow, SamplingWindow } from "./resource-windows";
import { ActivityWindow, ServerWindow, PackagesWindow } from "./system-windows";
import { CodexToolsWindow } from "./codex-tools";
import { StateInventoryWindow, SubscriptionsWindow } from "./state-windows";
import { ChatWindow } from "./chat-window";
import { RoleCatalogWindow } from "./role-catalog";
import { RoleEditorWindow } from "./role-editor";
import { RoleInstructionsWindow } from "./role-instructions";
import { RolePreviewWindow } from "./role-preview";
import { RoleMcpServersWindow, RoleProjectsWindow, RoleSkillsWindow } from "./role-resources";
import { RoleShimsWindow } from "./role-shims";
import { AccessWindow } from "./access-window";
import { InboxWindow, NotificationWindow } from "./notify-windows";
import { AttentionChangesWindow, AttentionMessagesWindow, AttentionRunsWindow, AttentionWindow, SignalWindow } from "./signal-windows";
import { ContentArtifactsWindow } from "./content-artifacts";
import { ContentDocumentsWindow } from "./content-documents";
import { ContentEditorWindow } from "./content-editor";
import { ContentLibraryWindow } from "./content-library";
import { ContentPreviewWindow } from "./content-preview";
import { WorkerRuntimesWindow, WorkersWindow } from "./worker-windows";
import { WorkerWindow } from "./worker-session";
import { ProcSchedulesWindow } from "./proc-schedules";
import { ProcScheduleWindow } from "./proc-schedule";
import { ProcRunsWindow } from "./proc-runs";
import { ProcRunWindow } from "./proc-run";
import { ProcTimelineWindow } from "./proc-timeline";
import { GoalIcon, HandIcon, NetworkIcon } from "lucide-react";
import { WorkWindow } from "./hud-work";
import { ItemWindow } from "./hud-item";
import { TimelineWindow } from "./hud-timeline";
import { ResourcesWindow as WorkResourcesWindow } from "./hud-resources";
import { AttentionWindow as WorkAttentionWindow } from "./hud-attention";

export type WindowDef = {
  /** Globally unique across spaces; also used by Window and node destinations. */
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
  width: number;
  /** Packing footprint, independent of live record count; content grows the window past it and pushes windows below. Defaults to 760. */
  height?: number;
  column: number;
  /** Keep the footprint height until a human sizes it, for windows that scroll their own content. */
  fixed?: boolean;
  element: React.ReactNode;
};

export const spaceViews: Record<SpaceId, {
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
  windows(state: StackState, arrangement: { chats: ChatWindows; workers: WorkerWindows; viewers: ViewerWindows; procRuns: ProcRunWindows }): WindowDef[];
}> = {
  fleet: {
    icon: BotIcon,
    accent: "bots",
    windows: (_state, { chats }) => [
      { id: "bots", title: "Bots", icon: BotIcon, accent: "bots", width: 420, height: 620, column: 0, element: <BotsWindow /> },
      // The primary chat sits beside Bots; each additional chat opens in the next column.
      ...chats.map((chat, index) => ({ id: chat.id, title: "Chat", icon: SquareTerminalIcon, accent: "bots" as const, width: 640, height: 720, column: index + 1, fixed: true,
        element: <ChatWindow id={chat.id} /> })),
    ],
  },
  hud: {
    icon: GoalIcon,
    accent: "hud",
    // Overview and attention on the left; the selected item's detail, history and deployed resources follow it.
    windows: () => [
      { id: "hud-attention", title: "Needs attention", icon: HandIcon, accent: "hud", width: 460, height: 380, column: 0, element: <WorkAttentionWindow /> },
      { id: "hud-work", title: "Work", icon: ListTreeIcon, accent: "hud", width: 460, height: 760, column: 0, fixed: true, element: <WorkWindow /> },
      { id: "hud-item", title: "Work item", icon: FileTextIcon, accent: "hud", width: 540, height: 820, column: 1, element: <ItemWindow /> },
      { id: "hud-timeline", title: "Timeline", icon: HistoryIcon, accent: "hud", width: 460, height: 820, column: 2, fixed: true, element: <TimelineWindow /> },
      { id: "hud-resources", title: "Resources", icon: NetworkIcon, accent: "hud", width: 460, height: 720, column: 3, element: <WorkResourcesWindow /> },
    ],
  },
  accounts: {
    icon: KeyRoundIcon,
    accent: "auth",
    windows: () => [
      { id: "accounts", title: "Accounts", icon: KeyRoundIcon, accent: "auth", width: 380, column: 0, element: <AccountsWindow /> },
      { id: "usage", title: "Usage", icon: GaugeIcon, accent: "server", width: 360, height: 520, column: 1, element: <UsageWindow /> },
      { id: "model-catalogs", title: "Models", icon: ListTreeIcon, accent: "bots", width: 460, height: 620, column: 2, element: <CatalogWindow /> },
    ],
  },
  lab: {
    icon: FlaskConicalIcon,
    accent: "events",
    windows: () => [
      { id: "call-speech", title: "Call speech", icon: MegaphoneIcon, accent: "bots", width: 400, height: 420, column: 0, element: <CallSpeechWindow /> },
      { id: "inference", title: "Inference", icon: SparklesIcon, accent: "bots", width: 440, height: 720, column: 1, element: <InferenceWindow /> },
    ],
  },
  system: {
    icon: CpuIcon,
    accent: "server",
    windows: () => [
      { id: "server", title: "Server", icon: CpuIcon, accent: "server", width: 400, height: 520, column: 0, element: <ServerWindow /> },
      { id: "access", title: "Access", icon: KeyRoundIcon, accent: "server", width: 460, height: 720, column: 4, element: <AccessWindow /> },
      { id: "packages", title: "Packages", icon: PackageIcon, accent: "server", width: 400, height: 420, column: 0, element: <PackagesWindow /> },
      { id: "resources", title: "Resources", icon: ChartLineIcon, accent: "server", width: 460, height: 640, column: 1, element: <ResourcesWindow /> },
      { id: "host", title: "Host", icon: ServerIcon, accent: "server", width: 400, height: 460, column: 1, element: <HostWindow /> },
      { id: "codex-tools", title: "Codex tools", icon: WrenchIcon, accent: "server", width: 460, height: 620, column: 2, element: <CodexToolsWindow /> },
      { id: "processes", title: "Processes", icon: ListTreeIcon, accent: "server", width: 560, height: 760, column: 2, element: <ProcessesWindow /> },
      { id: "sampling", title: "Sampling", icon: ScanLineIcon, accent: "server", width: 400, height: 560, column: 3, element: <SamplingWindow /> },
      { id: "activity", title: "Activity", icon: RadioIcon, accent: "events", width: 400, height: 460, column: 3, element: <ActivityWindow /> },
      { id: "state", title: "State", icon: DatabaseIcon, accent: "server", width: 500, height: 760, column: 5, element: <StateInventoryWindow /> },
      { id: "subscriptions", title: "Subscriptions", icon: CableIcon, accent: "server", width: 460, height: 560, column: 6, element: <SubscriptionsWindow /> },
    ],
  },
  roles: {
    icon: UserCogIcon,
    accent: "roles",
    windows: () => [
      { id: "role-catalog", title: "Roles", icon: UsersRoundIcon, accent: "roles", width: 380, height: 560, column: 0, element: <RoleCatalogWindow /> },
      { id: "role-instructions", title: "Instructions", icon: ScrollTextIcon, accent: "roles", width: 440, height: 720, column: 1, element: <RoleInstructionsWindow /> },
      { id: "role-editor", title: "Editor", icon: FilePenLineIcon, accent: "roles", width: 520, height: 760, column: 2, element: <RoleEditorWindow /> },
      { id: "role-preview", title: "Preview", icon: FileTextIcon, accent: "roles", width: 460, height: 720, column: 3, element: <RolePreviewWindow /> },
      { id: "role-skills", title: "Skills", icon: BlocksIcon, accent: "roles", width: 400, height: 300, column: 4, element: <RoleSkillsWindow /> },
      { id: "role-mcp-servers", title: "MCP servers", icon: PlugIcon, accent: "roles", width: 400, height: 440, column: 4, element: <RoleMcpServersWindow /> },
      { id: "role-projects", title: "Trusted projects", icon: FolderLockIcon, accent: "roles", width: 400, height: 240, column: 4, element: <RoleProjectsWindow /> },
      { id: "role-shims", title: "Shims", icon: SquareTerminalIcon, accent: "roles", width: 480, height: 560, column: 5, element: <RoleShimsWindow /> },
    ],
  },
  inbox: {
    icon: InboxIcon,
    accent: "notify",
    windows: () => [
      { id: "notify-inbox", title: "Inbox", icon: InboxIcon, accent: "notify", width: 440, height: 720, column: 0, fixed: true, element: <InboxWindow /> },
      { id: "notify-detail", title: "Notification", icon: BellIcon, accent: "notify", width: 480, height: 640, column: 1, element: <NotificationWindow /> },
    ],
  },
  signal: {
    icon: RadarIcon,
    accent: "events",
    windows: () => [
      { id: "signal", title: "Signal", icon: RadarIcon, accent: "events", width: 400, height: 640, column: 0, element: <SignalWindow /> },
      { id: "attention", title: "Attention", icon: MessageSquareWarningIcon, accent: "events", width: 520, height: 780, column: 1, fixed: true, element: <AttentionWindow /> },
      { id: "attention-messages", title: "Messages", icon: MessagesSquareIcon, accent: "events", width: 460, height: 780, column: 2, fixed: true, element: <AttentionMessagesWindow /> },
      { id: "attention-runs", title: "Runs", icon: HistoryIcon, accent: "events", width: 500, height: 520, column: 3, fixed: true, element: <AttentionRunsWindow /> },
      { id: "attention-changes", title: "Changes", icon: ActivityIcon, accent: "events", width: 500, height: 420, column: 3, fixed: true, element: <AttentionChangesWindow /> },
    ],
  },
  content: {
    icon: NotebookTextIcon,
    accent: "content",
    windows: () => [
      { id: "content-documents", title: "Documents", icon: NotebookTextIcon, accent: "content", width: 420, height: 560, column: 0, element: <ContentDocumentsWindow /> },
      { id: "content-library", title: "Library", icon: LibraryIcon, accent: "content", width: 560, height: 520, column: 0, element: <ContentLibraryWindow /> },
      { id: "content-editor", title: "Editor", icon: FilePenLineIcon, accent: "content", width: 540, height: 760, column: 1, element: <ContentEditorWindow /> },
      { id: "content-preview", title: "Preview", icon: EyeIcon, accent: "content", width: 480, height: 760, column: 2, element: <ContentPreviewWindow /> },
      { id: "content-artifacts", title: "Artifacts", icon: BoxesIcon, accent: "content", width: 400, height: 640, column: 3, element: <ContentArtifactsWindow /> },
    ],
  },
  workers: {
    icon: HammerIcon,
    accent: "worker",
    windows: (_state, { workers }) => [
      { id: "workers", title: "Workers", icon: HammerIcon, accent: "worker", width: 420, height: 720, column: 0, element: <WorkersWindow /> },
      // The primary Worker window sits beside the list; each additional one opens in the next column.
      ...workers.map((window, index) => ({ id: window.id, title: "Worker", icon: HammerIcon, accent: "worker" as const, width: 620, height: 760, column: index + 1, fixed: true,
        element: <WorkerWindow id={window.id} /> })),
      { id: "worker-runtimes", title: "Runtimes", icon: CpuIcon, accent: "worker", width: 380, height: 420, column: workers.length + 1, element: <WorkerRuntimesWindow /> },
    ],
  },
  scrape: {
    icon: GlobeIcon,
    accent: "scrape",
    windows: () => [
      { id: "scrape-extract", title: "Extract", icon: GlobeIcon, accent: "scrape", width: 580, height: 800, column: 0, fixed: true, element: <ExtractWindow /> },
      { id: "scrape-feeds", title: "Feeds", icon: RssIcon, accent: "scrape", width: 520, height: 640, column: 1, fixed: true, element: <FeedsWindow /> },
      { id: "scrape-convert", title: "Convert", icon: ArrowRightLeftIcon, accent: "scrape", width: 520, height: 420, column: 1, element: <ConvertWindow /> },
      { id: "scrape-presets", title: "Presets", icon: BlocksIcon, accent: "scrape", width: 460, height: 640, column: 2, element: <PresetsWindow /> },
      { id: "scrape-status", title: "Status", icon: GaugeIcon, accent: "scrape", width: 460, height: 340, column: 2, element: <StatusWindow /> },
      { id: "scrape-checks", title: "Checks", icon: ListChecksIcon, accent: "scrape", width: 440, height: 760, column: 3, fixed: true, element: <ChecksWindow /> },
      { id: "scrape-queue", title: "Queue", icon: FolderInputIcon, accent: "scrape", width: 480, height: 760, column: 4, fixed: true, element: <QueueWindow /> },
    ],
  },
  browse: {
    icon: MonitorIcon,
    accent: "browse",
    windows: (_state, { viewers }) => [
      { id: "browse-handoffs", title: "Handoffs", icon: LifeBuoyIcon, accent: "browse", width: 420, height: 640, column: 0, element: <HandoffsWindow /> },
      // The primary viewer sits beside Handoffs; each additional viewer opens in the next column.
      ...viewers.map((viewer, index) => ({ id: viewer.id, title: "Viewer", icon: MonitorIcon, accent: "browse" as const, width: 800, height: 640, column: index + 1, fixed: true,
        element: <ViewerWindow id={viewer.id} /> })),
      { id: "browse-profiles", title: "Profiles", icon: HardDriveIcon, accent: "browse", width: 420, height: 460, column: viewers.length + 1, element: <ProfilesWindow /> },
      { id: "browse-controllers", title: "Controllers", icon: CableIcon, accent: "browse", width: 420, height: 320, column: viewers.length + 1, element: <ControllersWindow /> },
      { id: "browse-toolchain", title: "Toolchain", icon: WrenchIcon, accent: "browse", width: 420, height: 720, column: viewers.length + 2, element: <ToolchainWindow /> },
    ],
  },
  brain: {
    icon: BrainIcon,
    accent: "brain",
    windows: () => [
      { id: "brain-search", title: "Search", icon: SearchIcon, accent: "brain", width: 520, height: 780, column: 0, fixed: true, element: <SearchWindow /> },
      { id: "brain-reader", title: "Reader", icon: BookOpenTextIcon, accent: "brain", width: 580, height: 780, column: 1, fixed: true, element: <ReaderWindow /> },
      { id: "brain-ingest", title: "Ingest", icon: ImportIcon, accent: "brain", width: 400, height: 560, column: 2, element: <IngestWindow /> },
      { id: "brain-jobs", title: "Jobs", icon: ListChecksIcon, accent: "brain", width: 480, height: 780, column: 3, fixed: true, element: <JobsWindow /> },
      { id: "brain-sources", title: "Sources", icon: SatelliteDishIcon, accent: "brain", width: 460, height: 640, column: 4, element: <SourcesWindow /> },
    ],
  },
  proc: {
    icon: CalendarClockIcon,
    accent: "proc",
    windows: (_state, { procRuns }) => [
      { id: "proc-schedules", title: "Schedules", icon: CalendarClockIcon, accent: "proc", width: 440, height: 720, column: 0, fixed: true, element: <ProcSchedulesWindow /> },
      { id: "proc-schedule", title: "Schedule", icon: CalendarClockIcon, accent: "proc", width: 520, height: 780, column: 1, element: <ProcScheduleWindow /> },
      { id: "proc-runs", title: "Runs", icon: SquareTerminalIcon, accent: "proc", width: 440, height: 720, column: 2, fixed: true, element: <ProcRunsWindow /> },
      // The primary Run window follows the list; each additional one keeps its run until closed.
      ...procRuns.map((window, index) => ({ id: window.id, title: "Run", icon: SquareTerminalIcon, accent: "proc" as const, width: 680, height: 780, column: index + 3, fixed: true,
        element: <ProcRunWindow id={window.id} /> })),
      { id: "proc-timeline", title: "Timeline", icon: ChartGanttIcon, accent: "proc", width: 760, height: 460, column: procRuns.length + 3, element: <ProcTimelineWindow /> },
    ],
  },
};
