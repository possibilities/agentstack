import type { ChildStatus, RunningOwner } from "./owner.js";

export type OwnerStatus = {
  pid: number;
  docsUrl: string | null;
  children: ChildStatus[];
};

export class StatusSource {
  private owner: RunningOwner | null = null;
  private docsUrl: string | null = null;
  onChange: (() => void) | undefined;

  attach(owner: RunningOwner): void {
    this.owner = owner;
  }

  setDocsUrl(url: string): void {
    this.docsUrl = url;
  }

  detach(): void {
    this.owner = null;
    this.docsUrl = null;
  }

  notify(): void {
    this.onChange?.();
  }

  snapshot(): OwnerStatus {
    return { pid: process.pid, docsUrl: this.docsUrl, children: this.owner?.children() ?? [] };
  }
}

export const statusSource = new StatusSource();
