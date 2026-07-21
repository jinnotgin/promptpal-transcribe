import { describe, expect, it, vi } from "vitest";
import { useLiveRecordingMp3Export } from "./useLiveRecordingMp3Export.js";

const nativeManifest =
  /** @type {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest} */ ({
    version: 1,
    duration: 4,
    source: "live",
    parts: [
      {
        index: 0,
        start: 0,
        end: 2,
        mimeType: "audio/webm;codecs=opus",
        sizeBytes: 3,
        fragmentCount: 1,
      },
      {
        index: 1,
        start: 2,
        end: 4,
        mimeType: "audio/webm;codecs=opus",
        sizeBytes: 3,
        fragmentCount: 1,
      },
    ],
  });

function createHarness(overrides = {}) {
  const mp3Manifest =
    /** @type {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest} */ ({
      version: 1,
      duration: 4,
      source: "live",
      parts: [
        {
          index: 0,
          start: 0,
          end: 4,
          mimeType: "audio/mpeg",
          sizeBytes: 3,
          fragmentCount: 1,
        },
      ],
    });
  const audioAssets = {
    getPartBlob: vi.fn(async (transcriptId, part) =>
      transcriptId.startsWith("__mp3-export__")
        ? new Blob(["ID3"], { type: "audio/mpeg" })
        : new Blob([`part-${part.index}`], { type: part.mimeType }),
    ),
    deleteAsset: vi.fn().mockResolvedValue(undefined),
    rollbackStaging: vi.fn().mockResolvedValue(undefined),
  };
  const audioPreparation = {
    open: vi.fn().mockResolvedValue(undefined),
    prepareWindow: vi
      .fn()
      .mockResolvedValue(new Float32Array([0.1, 0.2, 0.3, 0.4])),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
  };
  const session = {
    start: vi.fn().mockResolvedValue(undefined),
    appendPcm: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(mp3Manifest),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const streamingEncoderFactory = vi.fn(() => session);
  const exporter = useLiveRecordingMp3Export({
    audioAssets,
    audioPreparation,
    streamingEncoderFactory,
    createId: () => "__mp3-export__test",
    ...overrides,
  });
  return {
    exporter,
    audioAssets,
    audioPreparation,
    session,
    streamingEncoderFactory,
  };
}

describe("useLiveRecordingMp3Export", () => {
  it("decodes native parts sequentially and streams PCM into temporary v3 pages", async () => {
    const harness = createHarness();

    const result = await harness.exporter.convert({
      transcriptId: "live-recording",
      manifest: nativeManifest,
    });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("audio/mpeg");
    expect(harness.audioAssets.getPartBlob.mock.calls.slice(0, 2)).toEqual([
      ["live-recording", nativeManifest.parts[0]],
      ["live-recording", nativeManifest.parts[1]],
    ]);
    expect(harness.audioPreparation.open).toHaveBeenCalledTimes(2);
    expect(harness.session.appendPcm).toHaveBeenCalledTimes(2);
    expect(harness.session.finalize).toHaveBeenCalledOnce();
    expect(harness.audioAssets.getPartBlob).toHaveBeenLastCalledWith(
      "__mp3-export__test",
      expect.objectContaining({ mimeType: "audio/mpeg" }),
    );
    expect(harness.exporter.isConverting.value).toBe(false);

    await harness.exporter.release();
    expect(harness.audioAssets.rollbackStaging).toHaveBeenCalledWith(
      "__mp3-export__test",
    );
  });

  it("rejects a duplicate conversion while one is active", async () => {
    /** @type {(value?: unknown) => void} */
    let releaseAppend = () => {};
    const appendGate = new Promise((resolve) => {
      releaseAppend = resolve;
    });
    const harness = createHarness();
    harness.session.appendPcm.mockImplementation(() => appendGate);
    const pending = harness.exporter.convert({
      transcriptId: "live-recording",
      manifest: nativeManifest,
    });

    await expect(
      harness.exporter.convert({
        transcriptId: "live-recording",
        manifest: nativeManifest,
      }),
    ).rejects.toThrow("already in progress");
    releaseAppend();
    await pending;
  });

  it("cancels bounded decoding and removes temporary pages after a conversion failure", async () => {
    const harness = createHarness();
    harness.audioPreparation.prepareWindow.mockRejectedValueOnce(
      new Error("decode failed"),
    );

    await expect(
      harness.exporter.convert({
        transcriptId: "live-recording",
        manifest: nativeManifest,
      }),
    ).rejects.toThrow("decode failed");

    expect(harness.session.cancel).toHaveBeenCalledOnce();
    expect(harness.audioAssets.rollbackStaging).toHaveBeenCalledWith(
      "__mp3-export__test",
    );
    expect(harness.exporter.isConverting.value).toBe(false);
  });
});
