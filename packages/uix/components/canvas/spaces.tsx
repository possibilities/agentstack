"use client";

import { BotIcon, FlaskConicalIcon, KeyRoundIcon, GaugeIcon, ListTreeIcon, MegaphoneIcon } from "lucide-react";
import type { SpaceId } from "@/lib/stack/spaces";
import type { StackState } from "@/lib/stack/store";
import { type Accent } from "./window";
import { AccountsWindow, BotsWindow } from "./windows";
import { UsageWindow } from "./usage-window";
import { CatalogWindow } from "./catalog-window";
import { CallSpeechWindow } from "./call-speech-window";

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
      { id: "bots", title: "Bots", icon: BotIcon, accent: "bots", width: 420, height: 620, column: 0, element: <BotsWindow /> },
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
    ],
  },
};
