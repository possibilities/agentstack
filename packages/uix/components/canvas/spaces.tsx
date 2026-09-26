"use client";

import { BotIcon, IdCardIcon, KeyRoundIcon, GaugeIcon, ListTreeIcon } from "lucide-react";
import type { SpaceId } from "@/lib/stack/spaces";
import type { StackState } from "@/lib/stack/store";
import { type Accent } from "./window";
import { AccountsWindow, BotsWindow, WorkerAccountsWindow } from "./windows";
import { UsageWindow } from "./usage-window";
import { CatalogWindow } from "./catalog-window";

export type WindowDef = {
  /** Globally unique across spaces; also used by Window and node destinations. */
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
  width: number;
  /** Stable footprint, independent of live record count. Defaults to 760. */
  height?: number;
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
      { id: "worker-accounts", title: "Worker accounts", icon: IdCardIcon, accent: "auth", width: 360, column: 0, element: <WorkerAccountsWindow /> },
      { id: "accounts", title: "Bot accounts", icon: KeyRoundIcon, accent: "auth", width: 320, height: 520, column: 1, element: <AccountsWindow /> },
      { id: "usage", title: "Usage", icon: GaugeIcon, accent: "owner", width: 360, height: 520, column: 1, element: <UsageWindow /> },
      { id: "bots", title: "Bots", icon: BotIcon, accent: "bots", width: 420, height: 620, column: 2, element: <BotsWindow /> },
      { id: "model-catalogs", title: "Models", icon: ListTreeIcon, accent: "bots", width: 460, height: 620, column: 2, element: <CatalogWindow /> },
    ],
  },
};
