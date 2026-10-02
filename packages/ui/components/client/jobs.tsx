"use client";

import type { ClientOutput } from "@stack/client/contract";
import { Facts, RelativeTime, StatusChip, Steps, type Step, type Tone } from "./parts";

export type Job = ClientOutput<"client_job_get">;

const operationNames: Record<string, string> = { client_install: "Install", client_platform_start: "Start", client_platform_stop: "Stop", client_login_set: "Login preference" };
export const operationName = (operation: string) => operationNames[operation] ?? operation;

const stageNames: Record<string, string> = { admitted: "Admitted", downloading: "Downloading", extracting: "Extracting", runtime_install: "Installing shared codexnk runtime",
  selecting: "Selecting installed release", finished: "Finished", interrupted: "Interrupted", starting_service: "Starting user service", stopping_service: "Stopping user service",
  configuring_login: "Applying login preference" };
export const stageName = (stage: string) => stageNames[stage] ?? stage;

/** The host's recorded stage order for each local operation. */
const sequences: Record<string, string[]> = {
  client_install: ["admitted", "downloading", "extracting", "runtime_install", "selecting", "finished"],
  client_platform_start: ["admitted", "starting_service", "finished"],
  client_platform_stop: ["admitted", "stopping_service", "finished"],
  client_login_set: ["admitted", "configuring_login", "finished"],
};

const states: Record<Job["state"], { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "progress" }, completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" }, unknown: { label: "Outcome unknown", tone: "attention" },
};
export const jobState = (state: Job["state"]) => states[state] ?? { label: state, tone: "neutral" as Tone };
export const shortId = (id: string) => id.slice(0, 8);

/**
 * Steps only where the recorded stage locates the job. A failed or unknown job
 * whose stage is "finished" or "interrupted" does not say where it stopped, so it
 * gets no positional claim.
 */
export function jobSteps(job: Job): Step[] | null {
  const sequence = sequences[job.operation];
  const index = sequence?.indexOf(job.stage) ?? -1;
  if (!sequence || index < 0 || (job.state !== "completed" && job.stage === "finished")) return null;
  return sequence.map((stage, position) => {
    const label = stageName(stage);
    if (job.state === "completed" || position < index) return { key: stage, label, status: "done" };
    if (position > index) return { key: stage, label, status: job.state === "unknown" ? "unclaimed" : "pending" };
    if (job.state === "running") return { key: stage, label, status: "current", note: "In progress" };
    if (job.state === "failed") return { key: stage, label, status: "failed", note: "Failed" };
    return { key: stage, label, status: "unknown", note: "Last recorded" };
  });
}

/** Stage sequence, or the bare recorded stage when it cannot be placed. */
export function JobProgress({ job }: { job: Job }) {
  const steps = jobSteps(job);
  if (steps) return <Steps label={`${operationName(job.operation)} stages`} steps={steps} />;
  return <p className="text-sm">{job.stage === "interrupted" ? "Interrupted: the Client host stopped while this job was running. Its last stage was not retained."
    : job.stage === "finished" ? "The host recorded no stage for where this job stopped." : `Recorded stage: ${stageName(job.stage)}`}</p>;
}

/** One-line job identity: operation, state, age and short request ID. */
export function JobSummary({ job, now }: { job: Job; now: number | null }) {
  const state = jobState(job.state);
  return <>
    <span className="client-job-name">{operationName(job.operation)}</span>
    <StatusChip tone={state.tone}>{state.label}</StatusChip>
    <span className="client-job-meta"><RelativeTime at={job.createdAt} now={now} /><span aria-hidden>·</span><span className="font-mono">{shortId(job.id)}</span></span>
  </>;
}

/** Exact inspection of one retained job. */
export function JobDetails({ job }: { job: Job }) {
  return <div className="client-job-details" data-job-state={job.state}>
    <JobProgress job={job} />
    <Facts items={[["Request ID", job.id, { mono: true, key: "id" }], ...(job.error ? [["Reported error", job.error, { mono: true, key: "error" }] as [string, string, { mono: boolean; key: string }]] : [])]} />
    {job.state === "unknown" ? <p className="text-sm text-muted-foreground">This job is not replayed. Inspect current state before a new explicit action.</p> : null}
  </div>;
}
