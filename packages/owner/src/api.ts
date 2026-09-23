import type { PackageApi } from "@agentstack/api";

export type OwnerContext = Record<string, never>;

export const api: PackageApi<OwnerContext> = {
  operations: [],
  async createContext() {
    return {};
  },
  async closeContext() {},
};
