"use client";

import { BookOpenIcon, BotIcon, CpuIcon, IdCardIcon, KeyRoundIcon, ActivityIcon, GaugeIcon, ListTreeIcon } from "lucide-react";
import type { SpaceId } from "@/lib/stack/spaces";
import type { StackState } from "@/lib/stack/store";
import { accentOf, type Accent } from "./window";
import { AccountsWindow, ActivityWindow, BotsWindow, PackagesWindow, PackageWindow, SystemWindow, WorkerAccountsWindow } from "./windows";
import { UsageWindow } from "./usage-window";
import { CatalogWindow } from "./catalog-window";

export type WindowDef = {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
  width: number;
  column: number;
  element: React.ReactNode;
};

export const spaceViews: Record<SpaceId, {
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
  windows(state: StackState): WindowDef[];
}> = {
  fleet: {
    icon: BotIcon,
    accent: "bots",
    windows: () => [
      { id: "worker-accounts", title: "Worker accounts", icon: IdCardIcon, accent: "auth", width: 340, column: 0, element: <WorkerAccountsWindow /> },
      { id: "accounts", title: "Bot accounts", icon: KeyRoundIcon, accent: "auth", width: 320, column: 1, element: <AccountsWindow /> },
      { id: "bots", title: "Bots", icon: BotIcon, accent: "bots", width: 380, column: 2, element: <BotsWindow /> },
      { id: "model-catalogs", title: "Model catalogs", icon: ListTreeIcon, accent: "bots", width: 380, column: 0, element: <CatalogWindow /> },
      { id: "usage", title: "Usage", icon: GaugeIcon, accent: "owner", width: 380, column: 1, element: <UsageWindow /> },
    ],
  },
  system: {
    icon: CpuIcon,
    accent: "owner",
    windows: () => [
      { id: "system", title: "System", icon: CpuIcon, accent: "owner", width: 340, column: 0, element: <SystemWindow /> },
      { id: "activity", title: "Activity", icon: ActivityIcon, accent: "events", width: 380, column: 1, element: <ActivityWindow /> },
    ],
  },
  api: {
    icon: BookOpenIcon,
    accent: "api",
    windows: (state) => [
      { id: "packages", title: "Packages", icon: BookOpenIcon, accent: "api", width: 340, column: 0, element: <PackagesWindow /> },
      ...(state.catalog.data ?? []).map((doc, index) => ({
        id: `package:${doc.name}`,
        title: doc.name,
        icon: BookOpenIcon,
        accent: accentOf(doc.name),
        width: 460,
        column: 1 + (index % 3),
        element: <PackageWindow name={doc.name} />,
      })),
    ],
  },
};
