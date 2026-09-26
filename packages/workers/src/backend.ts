import type { AcpRequest } from "./acp.js";

/** Internal session operations shared by the durable manager. ACP is one implementation,
 * not the public identity of every Worker runtime. No transport is exposed here. */
export interface WorkerBackend {
  readonly pid: number | null;
  readonly pids?: number[];
  readonly exited: Promise<void>;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (request: AcpRequest) => boolean;
  request(method: string, params: object, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: object): void;
  respondRequest(id: number, result: unknown): void;
  cancelPermissions(sessionId?: string): void;
  close(): Promise<void>;
}
