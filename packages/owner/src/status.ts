import type { ChildStatus, RunningOwner } from "./owner.js";

export type OwnerStatus = {
  pid: number;
  indexUrl: string | null;
  uixUrl: string | null;
  inspectorUrl: string | null;
  mcpUrls: Record<string, string>;
  children: ChildStatus[];
};

export class StatusSource {
  private owner: RunningOwner | null = null;
  private indexUrl: string | null = null;
  private uixUrl: string | null = null;
  private inspectorUrl: string | null = null;
  private mcpUrls: Record<string, string> = {};
  onChange: (() => void) | undefined;

  attach(owner: RunningOwner): void {
    this.owner = owner;
  }

  setUixUrl(url: string): void {
    this.uixUrl = url;
  }

  setIndexUrl(url: string): void {
    this.indexUrl = url;
  }

  setInspectorUrl(url: string): void {
    this.inspectorUrl = url;
  }

  setMcpUrls(urls: Record<string, string>): void {
    this.mcpUrls = urls;
  }

  detach(): void {
    this.owner = null;
    this.indexUrl = null;
    this.uixUrl = null;
    this.inspectorUrl = null;
    this.mcpUrls = {};
  }

  notify(): void {
    this.onChange?.();
  }

  snapshot(): OwnerStatus {
    return {
      pid: process.pid,
      indexUrl: this.indexUrl,
      uixUrl: this.uixUrl,
      inspectorUrl: this.inspectorUrl,
      mcpUrls: this.mcpUrls,
      children: this.owner?.children() ?? [],
    };
  }

  resourceRoots() {
    return { pid: process.pid, attached: this.owner !== null, children: this.owner?.children() ?? [] };
  }
}

export const statusSource = new StatusSource();
