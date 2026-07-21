import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  TRANSCRIPTION_DB_NAME,
} from "@/features/transcription/lib/transcriptionDb.js";
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";
import {
  canUseStreamingWebmEncoder,
  useStreamingWebmEncoder,
} from "./useStreamingWebmEncoder.js";

const resetDb = async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
};

function createEncoderFactory() {
  const state = { added: [], cancel: vi.fn() };
  const factory = vi.fn(async ({ writable }) => {
    const writer = writable.getWriter();
    return {
      mimeType: "audio/webm;codecs=opus",
      async start() {},
      async addPcm(pcm, timestampSeconds) {
        state.added.push({
          pcm: [...pcm],
          timestampSeconds,
          ownsExactBuffer:
            pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength,
        });
      },
      async finalize() {
        await writer.write({
          type: "write",
          position: 0,
          data: new Uint8Array([1, 2, 3, 4]),
        });
        await writer.write({
          type: "write",
          position: 4,
          data: new Uint8Array([5, 6]),
        });
        await writer.write({
          type: "write",
          position: 1,
          data: new Uint8Array([9, 9]),
        });
        await writer.close();
      },
      async cancel() {
        state.cancel();
        try {
          await writer.abort();
        } catch {
          // The stream may already be closed.
        }
      },
    };
  });
  return { factory, state };
}

describe("useStreamingWebmEncoder", () => {
  beforeEach(resetDb);
  afterEach(async () => {
    if (db.isOpen()) db.close();
    await Dexie.delete(TRANSCRIPTION_DB_NAME);
  });

  it("detects native mono Opus encoding support through the lazy runtime", async () => {
    const canEncodeAudio = vi.fn().mockResolvedValue(true);

    await expect(
      canUseStreamingWebmEncoder({
        runtimeLoader: async () => ({ canEncodeAudio }),
      }),
    ).resolves.toBe(true);
    expect(canEncodeAudio).toHaveBeenCalledWith("opus", {
      numberOfChannels: 1,
      sampleRate: 16_000,
      bitrate: 64_000,
    });
  });

  it("subdivides ordered PCM and finalizes one position-aware WebM manifest", async () => {
    const encoder = createEncoderFactory();
    const audioAssets = useTranscriptionAudioAssets({ leaseStorage: null });
    const session = useStreamingWebmEncoder({
      transcriptId: "upload-webm-continuous",
      audioAssets,
      encoderFactory: encoder.factory,
      sampleRate: 4,
      pageSize: 4,
      maxSampleSeconds: 1,
    });

    await session.start();
    await session.appendPcm(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const manifest = await session.finalize();

    expect(encoder.state.added).toEqual([
      { pcm: [0, 1, 2, 3], timestampSeconds: 0, ownsExactBuffer: true },
      { pcm: [4, 5, 6, 7], timestampSeconds: 1, ownsExactBuffer: true },
      { pcm: [8, 9], timestampSeconds: 2, ownsExactBuffer: true },
    ]);
    expect(manifest).toMatchObject({
      version: 1,
      duration: 2.5,
      source: "upload",
      parts: [
        {
          index: 0,
          start: 0,
          end: 2.5,
          mimeType: "audio/webm;codecs=opus",
          sizeBytes: 6,
          fragmentCount: 2,
        },
      ],
    });
    const blob = await audioAssets.getPartBlob(
      "upload-webm-continuous",
      manifest.parts[0],
    );
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 9, 9, 4, 5, 6]),
    );
    expect(session.getState()).toMatchObject({
      status: "finalized",
      pendingPcmChunks: 0,
      sink: { maxWriteBytes: 4, rewriteCount: 1 },
    });
  });

  it("cancels the encoder and rolls back staged WebM pages", async () => {
    const encoder = createEncoderFactory();
    const audioAssets = useTranscriptionAudioAssets({ leaseStorage: null });
    const session = useStreamingWebmEncoder({
      transcriptId: "upload-webm-cancel",
      audioAssets,
      encoderFactory: encoder.factory,
      sampleRate: 4,
      pageSize: 4,
    });
    await session.start();
    await audioAssets.stagePositionedWrite({
      transcriptId: "upload-webm-cancel",
      partIndex: 0,
      position: 0,
      data: new Uint8Array([1, 2]),
      pageSize: 4,
      mimeType: "audio/webm;codecs=opus",
    });

    await session.cancel();

    expect(encoder.state.cancel).toHaveBeenCalledOnce();
    expect(await db.transcriptAudioFragments.count()).toBe(0);
  });
});
