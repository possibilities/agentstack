"use client";

import { ActivityIcon, BellIcon, HammerIcon, BlocksIcon, BotIcon, BoxesIcon, EyeIcon, LibraryIcon, NotebookTextIcon, ChartLineIcon, CpuIcon, FilePenLineIcon, FileTextIcon, FlaskConicalIcon, FolderLockIcon, GaugeIcon, HistoryIcon, InboxIcon, KeyRoundIcon, ListTreeIcon, MegaphoneIcon, MessageSquareWarningIcon, MessagesSquareIcon, PackageIcon, PlugIcon, RadarIcon, RadioIcon, ScanLineIcon, ScrollTextIcon, ServerIcon, SparklesIcon, SquareTerminalIcon, UserCogIcon } from "lucide-react";
import type { ChatWindows } from "@/lib/stack/chat-windows";
import type { WorkerWindows } from "@/lib/stack/worker-windows";
import type { SpaceId } from "@/lib/stack/spaces";
import type { StackState } from "@/lib/stack/store";
import { type Accent } from "./window";
import { AccountsWindow, BotsWindow } from "./windows";
import { UsageWindow } from "./usage-window";
import { CatalogWindow } from "./catalog-window";
import { CallSpeechWindow } from "./call-speech-window";
import { InferenceWindow } from "./inference-window";
import { HostWindow, ProcessesWindow, ResourcesWindow, SamplingWindow } from "./resource-windows";
import { ActivityWindow, OwnerWindow, PackagesWindow } from "./system-windows";
import { ChatWindow } from "./chat-window";
import { RoleEditorWindow } from "./role-editor";
import { RoleInstructionsWindow } from "./role-instructions";
import { RolePreviewWindow } from "./role-preview";
import { RoleMcpServersWindow, RoleProjectsWindow, RoleSkillsWindow } from "./role-resources";
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
  windows(state: StackState, arrangement: { chats: ChatWindows; workers: WorkerWindows }): WindowDef[];
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
  accounts: {
    icon: KeyRoundIcon,
    accent: "auth",
    windows: () => [
      { id: "accounts", title: "Accounts", icon: KeyRoundIcon, accent: "auth", width: 380, column: 0, element: <AccountsWindow /> },
      { id: "usage", title: "Usage", icon: GaugeIcon, accent: "owner", width: 360, height: 520, column: 1, element: <UsageWindow /> },
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
    accent: "owner",
    windows: () => [
      { id: "owner", title: "Owner", icon: CpuIcon, accent: "owner", width: 400, height: 520, column: 0, element: <OwnerWindow /> },
      { id: "access", title: "Access", icon: KeyRoundIcon, accent: "owner", width: 460, height: 720, column: 4, element: <AccessWindow /> },
      { id: "packages", title: "Packages", icon: PackageIcon, accent: "owner", width: 400, height: 420, column: 0, element: <PackagesWindow /> },
      { id: "resources", title: "Resources", icon: ChartLineIcon, accent: "owner", width: 460, height: 640, column: 1, element: <ResourcesWindow /> },
      { id: "host", title: "Host", icon: ServerIcon, accent: "owner", width: 400, height: 460, column: 1, element: <HostWindow /> },
      { id: "processes", title: "Processes", icon: ListTreeIcon, accent: "owner", width: 560, height: 760, column: 2, element: <ProcessesWindow /> },
      { id: "sampling", title: "Sampling", icon: ScanLineIcon, accent: "owner", width: 400, height: 560, column: 3, element: <SamplingWindow /> },
      { id: "activity", title: "Activity", icon: RadioIcon, accent: "events", width: 400, height: 460, column: 3, element: <ActivityWindow /> },
    ],
  },
  roles: {
    icon: UserCogIcon,
    accent: "roles",
    windows: () => [
      { id: "role-instructions", title: "Instructions", icon: ScrollTextIcon, accent: "roles", width: 440, height: 720, column: 0, element: <RoleInstructionsWindow /> },
      { id: "role-editor", title: "Editor", icon: FilePenLineIcon, accent: "roles", width: 520, height: 760, column: 1, element: <RoleEditorWindow /> },
      { id: "role-preview", title: "Preview", icon: FileTextIcon, accent: "roles", width: 460, height: 720, column: 2, element: <RolePreviewWindow /> },
      { id: "role-skills", title: "Skills", icon: BlocksIcon, accent: "roles", width: 400, height: 300, column: 3, element: <RoleSkillsWindow /> },
      { id: "role-mcp-servers", title: "MCP servers", icon: PlugIcon, accent: "roles", width: 400, height: 280, column: 3, element: <RoleMcpServersWindow /> },
      { id: "role-projects", title: "Trusted projects", icon: FolderLockIcon, accent: "roles", width: 400, height: 240, column: 3, element: <RoleProjectsWindow /> },
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
};
