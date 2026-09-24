import type { ChildStatus, RunningOwner } from "./owner.js";

export type OwnerStatus = {
  pid: number;
  children: ChildStatus[];
};

export class StatusSource {
  private owner: RunningOwner | null = null;
  onChange: (() => void) | undefined;

  attach(owner: RunningOwner): void {
    this.owner = owner;
  }

  detach(): void {
    this.owner = null;
  }

  notify(): void {
    this.onChange?.();
  }

  snapshot(): OwnerStatus {
    return { pid: process.pid, children: this.owner?.children() ?? [] };
  }
}

export const statusSource = new StatusSource();
