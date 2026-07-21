import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  TRANSCRIPTION_DB_NAME,
} from "@/features/transcription/lib/transcriptionDb.js";
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";
import { useStreamingMp3Encoder } from "./useStreamingMp3Encoder.js";

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
      mimeType: "audio/mpeg",
      async start() {},
      async addPcm(pcm, timestampSeconds) {
        state.added.push({ pcm: [...pcm], timestampSeconds });
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

describe("useStreamingMp3Encoder", () => {
  beforeEach(resetDb);
  afterEach(async () => {
    if (db.isOpen()) db.close();
    await Dexie.delete(TRANSCRIPTION_DB_NAME);
  });

  it("streams ordered PCM to position-aware v3 pages and finalizes one MP3 manifest", async () => {
    const encoder = createEncoderFactory();
    const audioAssets = useTranscriptionAudioAssets({ leaseStorage: null });
    const session = useStreamingMp3Encoder({
      transcriptId: "__mp3-export__bounded",
      source: "live",
      audioAssets,
      encoderFactory: encoder.factory,
      sampleRate: 4,
      pageSize: 4,
    });

    await session.start();
    await session.appendPcm(new Float32Array([0.1, 0.2, 0.3, 0.4]));
    await session.appendPcm(new Float32Array([0.5, 0.6, 0.7, 0.8]));
    const manifest = await session.finalize();

    expect(
      encoder.state.added.map(({ timestampSeconds }) => timestampSeconds),
    ).toEqual([0, 1]);
    expect(manifest).toMatchObject({
      version: 1,
      duration: 2,
      source: "live",
      parts: [{ mimeType: "audio/mpeg", sizeBytes: 6, fragmentCount: 2 }],
    });
    expect("storageKey" in manifest.parts[0]).toBe(false);
    expect("extension" in manifest.parts[0]).toBe(false);
    const blob = await audioAssets.getPartBlob(
      "__mp3-export__bounded",
      manifest.parts[0],
    );
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 9, 9, 4, 5, 6]),
    );
  });

  it("cancels the encoder and removes temporary pages", async () => {
    const encoder = createEncoderFactory();
    const audioAssets = useTranscriptionAudioAssets({ leaseStorage: null });
    const session = useStreamingMp3Encoder({
      transcriptId: "__mp3-export__cancel",
      source: "live",
      audioAssets,
      encoderFactory: encoder.factory,
      sampleRate: 4,
      pageSize: 4,
    });
    await session.start();
    await session.appendPcm(new Float32Array(4));

    await session.cancel();

    expect(encoder.state.cancel).toHaveBeenCalledOnce();
    expect(await db.transcriptAudioFragments.count()).toBe(0);
  });
});
