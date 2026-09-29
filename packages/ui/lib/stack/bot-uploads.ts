export type UploadReceipt = { id: string; botId: string; offset: number; path: string | null; bytes: number; name: string; sha256: string };
export type BotUploadState = { id: string; file: File; receipt: UploadReceipt | null; error: string | null; pending: boolean };
type UploadCall = (name: string, input: Record<string, unknown>) => Promise<UploadReceipt>;

/** Page-owned uploads survive dialog dismissal; only run() admits/resumes work. */
export class BotUploads {
  private state: Record<string, BotUploadState> = {};
  private listeners = new Set<() => void>();
  private call: UploadCall;

  constructor(call: UploadCall) { this.call = call; }

  getState = (): Record<string, BotUploadState> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  select = (botId: string, file: File): void => {
    if (this.state[botId]?.pending) return;
    this.set(botId, { id: crypto.randomUUID(), file, receipt: null, error: null, pending: false });
  };

  private set(botId: string, value: BotUploadState): void {
    this.state = { ...this.state, [botId]: value };
    for (const listener of this.listeners) listener();
  }

  run = async (botId: string): Promise<void> => {
    const upload = this.state[botId];
    if (!upload || upload.pending || upload.receipt?.path) return;
    const { file, id } = upload;
    const update = (patch: Partial<BotUploadState>) => this.set(botId, { ...this.state[botId], ...patch });
    if (!file.size || file.size > 20_000_000) { update({ error: "Choose a non-empty file no larger than 20 MB." }); return; }
    // Set the lock before yielding, including before reading/hashing the File.
    update({ pending: true, error: null });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      await this.call("chat_upload_start", { botId, id, name: file.name, bytes: bytes.length, sha256 });
      let receipt = await this.call("chat_upload_status", { botId, id });
      update({ receipt });
      while (!receipt.path && receipt.offset < bytes.length) {
        const chunk = bytes.subarray(receipt.offset, receipt.offset + 256 * 1024);
        let binary = "";
        for (const byte of chunk) binary += String.fromCharCode(byte);
        const previous = receipt.offset;
        receipt = await this.call("chat_upload_chunk", { botId, id, offset: previous, data: btoa(binary) });
        if (receipt.offset <= previous) throw new Error("Upload did not advance; inspect its status");
        update({ receipt });
      }
      if (!receipt.path) update({ receipt: await this.call("chat_upload_finish", { botId, id }) });
    } catch (cause) {
      update({ error: `${cause instanceof Error ? cause.message : String(cause)}. Resume checks the server offset before sending more bytes.` });
    } finally { update({ pending: false }); }
  };
}
