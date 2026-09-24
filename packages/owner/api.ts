import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { statusSource, type StatusSource } from "./src/status.js";

const childStatusSchema = z.object({
  name: z.string().describe("Required child name."),
  pid: z.number().int().nullable().describe("Process id while running, otherwise null."),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable().describe("Spawn failure message, if any."),
});

export type OwnerContext = {
  source: StatusSource;
};

export const ownerStatus = operation({
  name: "owner_status",
  description: "Read the owner process, its docs and UI canvas URLs, and each required child's status: pid, running, exit code, signal, and spawn error.",
  input: z.strictObject({}),
  output: z.object({
    pid: z.number().int().describe("Owner process id."),
    docsUrl: z.string().nullable().describe("Loopback docs URL while the owner serves it."),
    uixUrl: z.string().nullable().describe("Loopback UI canvas URL while the owner runs it."),
    children: z.array(childStatusSchema),
  }),
  annotations: { title: "Owner status", readOnlyHint: true },
  async call(ctx: OwnerContext) {
    return ctx.source.snapshot();
  },
});

export const topics = {
  pids_changed: "Published when the set of owned child process ids changes.",
} as const;

export type OwnerTopic = keyof typeof topics;

export const api: PackageApi<OwnerContext, OwnerTopic> = {
  operations: [ownerStatus],
  events: {
    topics,
    start(ctx: OwnerContext, publish: (topic: OwnerTopic) => void) {
      ctx.source.onChange = () => publish("pids_changed");
      return () => {
        ctx.source.onChange = undefined;
      };
    },
  },
  async createContext() {
    return { source: statusSource };
  },
  async closeContext(ctx) {
    ctx.source.detach();
  },
};
