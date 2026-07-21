function validateTargetChunk(chunk) {
  if (!chunk || chunk.type !== "write")
    throw new TypeError("Audio target chunk must be a write");
  if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength <= 0) {
    throw new TypeError("Audio target chunk must contain bytes");
  }
  if (!Number.isSafeInteger(chunk.position) || chunk.position < 0) {
    throw new TypeError("Audio target position must be a non-negative integer");
  }
}

/**
 * Position-aware writable backed by bounded temporary rows in the existing
 * transcription IndexedDB v3 fragment table.
 * @param {{
 *   transcriptId: string,
 *   partIndex?: number,
 *   pageSize: number,
 *   mimeType?: string,
 *   audioAssets: ReturnType<import('./useTranscriptionAudioAssets.js').useTranscriptionAudioAssets>,
 * }} options
 */
export function useTranscriptAudioPageSink(options) {
  const partIndex = options.partIndex ?? 0;
  const mimeType = options.mimeType || "audio/mpeg";
  let finalized = false;
  let aborted = false;
  let sizeBytes = 0;
  let writeCount = 0;
  let rewriteCount = 0;
  let maxWriteBytes = 0;
  let pendingWrites = 0;
  let maxPendingWrites = 0;

  const writable = new WritableStream(
    {
      async write(chunk) {
        validateTargetChunk(chunk);
        pendingWrites += 1;
        maxPendingWrites = Math.max(maxPendingWrites, pendingWrites);
        try {
          if (chunk.position < sizeBytes) rewriteCount += 1;
          await options.audioAssets.stagePositionedWrite({
            transcriptId: options.transcriptId,
            partIndex,
            position: chunk.position,
            data: chunk.data,
            pageSize: options.pageSize,
            mimeType,
          });
          sizeBytes = Math.max(
            sizeBytes,
            chunk.position + chunk.data.byteLength,
          );
          writeCount += 1;
          maxWriteBytes = Math.max(maxWriteBytes, chunk.data.byteLength);
        } finally {
          pendingWrites -= 1;
        }
      },
      close() {
        finalized = true;
      },
      async abort() {
        aborted = true;
        await options.audioAssets.rollbackStaging(options.transcriptId);
      },
    },
    { highWaterMark: 2 },
  );

  return {
    writable,
    async getStats() {
      return options.audioAssets.getStagedPartStats(
        options.transcriptId,
        partIndex,
      );
    },
    getDiagnostics() {
      return {
        finalized,
        aborted,
        sizeBytes,
        writeCount,
        rewriteCount,
        maxWriteBytes,
        maxPendingWrites,
      };
    },
  };
}
