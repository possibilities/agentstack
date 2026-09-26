"use client";

import { BotIcon, IdCardIcon, KeyRoundIcon } from "lucide-react";
import type { SpaceId } from "@/lib/stack/spaces";
import type { StackState } from "@/lib/stack/store";
import { type Accent } from "./window";
import { AccountsWindow, BotsWindow, WorkerAccountsWindow } from "./windows";

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
      { id: "worker-accounts", title: "Worker accounts", icon: IdCardIcon, accent: "auth", width: 340, column: 0, element: <WorkerAccountsWindow /> },
      { id: "accounts", title: "Bot accounts", icon: KeyRoundIcon, accent: "auth", width: 320, column: 1, element: <AccountsWindow /> },
      { id: "bots", title: "Bots", icon: BotIcon, accent: "bots", width: 380, column: 2, element: <BotsWindow /> },
    ],
  },
};
