import { bytesToBase64, inlineLimit } from "./content";
import type { ContentStage } from "./types";

export type ContentCall = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

/** An upload that stopped with bytes safely staged; resuming continues from the server's acknowledged offset. */
export class StageStalled extends Error {
  readonly stageId: string | null;
  readonly received: number;
  constructor(message: string, stageId: string | null, received: number) {
    super(message);
    this.stageId = stageId;
    this.received = received;
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Stage keys deduplicate uncertain starts: identical bytes resume the same stage instead of starting over. */
export const stageKey = (digest: string, bytes: number): string => `ui:${bytes}:${digest}`;

/**
 * Upload bytes through Content's resumable blob stage and return the verified content digest.
 * After any failed chunk the next offset comes from `blob_stage_status`, never from a guess.
 */
export async function stageBytes(call: ContentCall, bytes: Uint8Array, digest: string,
  onProgress: (received: number, stageId: string) => void = () => {}): Promise<string> {
  let stage: ContentStage;
  try {
    stage = await call<ContentStage>("blob_stage_start", { bytes: bytes.length, digest, clientKey: stageKey(digest, bytes.length) });
  } catch (error) {
    // Starting again with the same key is safe: it returns the stage a lost response created.
    try { stage = await call<ContentStage>("blob_stage_start", { bytes: bytes.length, digest, clientKey: stageKey(digest, bytes.length) }); }
    catch { throw new StageStalled(message(error), null, 0); }
  }
  onProgress(stage.received, stage.id);
  let stuck = 0;
  while (!stage.blob && stage.received < stage.bytes) {
    const offset = stage.received;
    const chunk = bytes.subarray(offset, Math.min(offset + inlineLimit, bytes.length));
    try {
      stage = await call<ContentStage>("blob_stage_chunk", { id: stage.id, offset, base64: bytesToBase64(chunk) });
      stuck = 0;
    } catch (error) {
      let status: ContentStage;
      try { status = await call<ContentStage>("blob_stage_status", { id: stage.id }); }
      catch { throw new StageStalled(message(error), stage.id, offset); }
      if (status.received <= offset && ++stuck >= 3) throw new StageStalled(message(error), stage.id, status.received);
      stage = status;
    }
    onProgress(stage.received, stage.id);
  }
  if (!stage.blob) {
    try { stage = await call<ContentStage>("blob_stage_finish", { id: stage.id }); }
    catch (error) {
      let status: ContentStage;
      try { status = await call<ContentStage>("blob_stage_status", { id: stage.id }); }
      catch { throw new StageStalled(message(error), stage.id, stage.received); }
      if (!status.blob) {
        // A digest mismatch or an incomplete stage is definite; anything else can be finished again later.
        if (/digest mismatch/.test(message(error))) throw error;
        throw new StageStalled(message(error), stage.id, status.received);
      }
      stage = status;
    }
  }
  if (stage.blob !== digest) throw new Error("the server verified different bytes than this page sent");
  return stage.blob;
}
