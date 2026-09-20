export const CONTROL_SCHEMA = "agentstack.control.v1" as const;
export const SYSTEM_INVENTORY_SCHEMA = "agentstack.system.v1" as const;

export const CHILD_IDS = ["codex", "fx"] as const;
export type ChildId = (typeof CHILD_IDS)[number];

export type ObservedState =
  "stopped" | "starting" | "running" | "backoff" | "stopping" | "failed";

export type Readiness =
  "unknown" | "ready" | "auth-required" | "incompatible" | "unavailable";

export interface SanitizedFailure {
  code: string;
  message: string;
  at: string;
}

export interface ChildStatus {
  id: ChildId;
  sourceVersion: string;
  generation: string | null;
  pid: number | null;
  desiredState: "running" | "stopped";
  observedState: ObservedState;
  readiness: Readiness;
  startedAt: string | null;
  uptimeMs: number | null;
  restartCount: number;
  backoffUntil: string | null;
  lastFailure: SanitizedFailure | null;
}

export interface ProcessComponent {
  id: string;
  name: string;
  kind: "daemon" | "engine" | "worker";
  owner: string;
  desiredState: "running" | "stopped";
  observedState: ObservedState;
  pid: number | null;
  version: string;
  build: string;
  source: string;
  startedAt: string | null;
  uptimeMs: number | null;
  readiness: Readiness;
  generation: string | null;
  restartCount: number;
  lastFailure: SanitizedFailure | null;
  inventory: ComponentInventory;
}

export interface ComponentCapabilityDescriptor {
  id: string;
  name: string;
  summary: string;
}

export interface ComponentPreferenceDescriptor {
  id: string;
  name: string;
  valueType: "boolean" | "enum" | "number" | "path" | "string";
  mutable: boolean;
  sensitive: false;
  summary: string;
}

export interface ComponentInventory {
  summary: string;
  capabilities: ComponentCapabilityDescriptor[];
  preferences: ComponentPreferenceDescriptor[];
}

export interface SystemInventory {
  schema: typeof SYSTEM_INVENTORY_SCHEMA;
  components: ProcessComponent[];
}

export interface StatusResponse {
  schema: typeof CONTROL_SCHEMA;
  productVersion: string;
  installedVersion: string;
  runningVersion: string;
  buildIdentity: string;
  installPath: string;
  daemon: {
    generation: string;
    pid: number;
    startedAt: string;
    desiredState: "running";
  };
  systemInventory: SystemInventory;
  /** Derived convenience view retained for milestone-one clients. */
  children: Record<ChildId, ChildStatus>;
}

export interface ErrorResponse {
  schema: typeof CONTROL_SCHEMA;
  error: {
    code: string;
    message: string;
  };
}

export function isChildId(value: string): value is ChildId {
  return CHILD_IDS.some((id) => id === value);
}

export function assertValidProcessComponents(
  components: ProcessComponent[],
): void {
  const ids = new Set<string>();
  for (const component of components) {
    if (!/^[a-z][a-z0-9.-]*$/.test(component.id) || ids.has(component.id)) {
      throw new Error(`invalid or duplicate component id: ${component.id}`);
    }
    ids.add(component.id);
    if (
      !component.name.trim() ||
      !component.owner.trim() ||
      !component.source.trim() ||
      !component.inventory.summary.trim()
    ) {
      throw new Error(
        `component ${component.id} lacks safe inventory metadata`,
      );
    }
    const capabilityIds = new Set<string>();
    for (const capability of component.inventory.capabilities) {
      if (
        !capability.id.trim() ||
        !capability.name.trim() ||
        !capability.summary.trim() ||
        capabilityIds.has(capability.id)
      ) {
        throw new Error(
          `component ${component.id} has invalid capability metadata`,
        );
      }
      capabilityIds.add(capability.id);
    }
    const preferenceIds = new Set<string>();
    for (const preference of component.inventory.preferences) {
      if (
        !preference.id.trim() ||
        !preference.name.trim() ||
        !preference.summary.trim() ||
        preference.sensitive !== false ||
        preferenceIds.has(preference.id)
      ) {
        throw new Error(
          `component ${component.id} has unsafe preference metadata`,
        );
      }
      preferenceIds.add(preference.id);
    }
  }
}

export function createSystemInventory(
  components: ProcessComponent[],
): SystemInventory {
  assertValidProcessComponents(components);
  return { schema: SYSTEM_INVENTORY_SCHEMA, components: [...components] };
}
