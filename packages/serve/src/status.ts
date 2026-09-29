import type { ChildStatus, RunningServer } from "./server.js";

export type ServerStatus = {
  pid: number;
  /** ISO time the server process started. */
  startedAt: string;
  /** Node.js version string of the server process. */
  nodeVersion: string;
  indexUrl: string | null;
  uiUrl: string | null;
  inspectorUrl: string | null;
  mcpUrls: Record<string, string>;
  children: ChildStatus[];
};

export class StatusSource {
  private server: RunningServer | null = null;
  private readonly startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  private indexUrl: string | null = null;
  private uiUrl: string | null = null;
  private inspectorUrl: string | null = null;
  private mcpUrls: Record<string, string> = {};
  onChange: (() => void) | undefined;

  attach(server: RunningServer): void {
    this.server = server;
  }

  setUiUrl(url: string): void {
    this.uiUrl = url;
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
    this.server = null;
    this.indexUrl = null;
    this.uiUrl = null;
    this.inspectorUrl = null;
    this.mcpUrls = {};
  }

  notify(): void {
    this.onChange?.();
  }

  snapshot(): ServerStatus {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      nodeVersion: process.version,
      indexUrl: this.indexUrl,
      uiUrl: this.uiUrl,
      inspectorUrl: this.inspectorUrl,
      mcpUrls: this.mcpUrls,
      children: this.server?.children() ?? [],
    };
  }

  resourceRoots() {
    return { pid: process.pid, attached: this.server !== null, children: this.server?.children() ?? [] };
  }
}

export const statusSource = new StatusSource();
