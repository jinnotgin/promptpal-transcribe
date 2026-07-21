import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscriptionPipeline } from "./useTranscriptionPipeline.js";

const mocks = vi.hoisted(() => ({
  prepared: [],
  readStarts: [],
  closed: vi.fn(),
  aborted: vi.fn(),
  beginStaging: vi.fn(),
  finishStaging: vi.fn(),
  assertStorageHeadroom: vi.fn(),
  rollbackStaging: vi.fn(),
  stageFragment: vi.fn(),
  continuousSupported: true,
  continuousStart: vi.fn(),
  continuousAppend: vi.fn(),
  continuousFinalize: vi.fn(),
  continuousCancel: vi.fn(),
  vadCalls: 0,
}));

vi.mock(
  "@/features/transcription/lib/audioWindowing.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    getCommittedPcmView: vi.fn((pcm) => pcm),
  }),
);

vi.mock("./useStreamingWebmEncoder.js", () => ({
  canUseStreamingWebmEncoder: vi.fn(async () => mocks.continuousSupported),
  useStreamingWebmEncoder: vi.fn(() => ({
    start: mocks.continuousStart,
    appendPcm: mocks.continuousAppend,
    finalize: mocks.continuousFinalize,
    cancel: mocks.continuousCancel,
  })),
}));

vi.mock("./useModelManager.js", () => ({
  useModelManager: () => ({
    checkCache: vi.fn().mockResolvedValue(undefined),
    ensureDiarizationModel: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
  }),
}));

vi.mock("./useAudioPreparation.js", () => ({
  useAudioPreparation: () => ({
    open: vi.fn().mockResolvedValue({ duration: 620 }),
    prepareWindow: vi.fn(async (window) => {
      mocks.prepared.push(window.index);
      mocks.readStarts.push(window.readStart);
      return new Float32Array(16000);
    }),
    prepareWindowWithProxy: vi.fn(async (window) => {
      mocks.prepared.push(window.index);
      mocks.readStarts.push(window.readStart);
      return {
        pcm: new Float32Array(16000),
        proxyBlob: new Blob([`webm-${window.index}`], {
          type: "audio/webm;codecs=opus",
        }),
      };
    }),
    close: mocks.closed,
    abort: mocks.aborted,
  }),
}));

vi.mock("./useTranscriptionAudioAssets.js", () => ({
  useTranscriptionAudioAssets: () => ({
    beginStaging: mocks.beginStaging,
    finishStaging: mocks.finishStaging,
    assertStorageHeadroom: mocks.assertStorageHeadroom,
    rollbackStaging: mocks.rollbackStaging,
    stageFragment: mocks.stageFragment,
  }),
}));

vi.mock("./useVoiceActivityDetection.js", () => ({
  useVoiceActivityDetection: () => ({
    detectWindow: vi.fn(async (pcm) => {
      if (mocks.vadCalls === 0) expect(mocks.prepared).toEqual([0, 1]);
      mocks.vadCalls += 1;
      return { regions: [{ start: 0, end: 1, preChunked: true }], pcm };
    }),
    detect: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock("./useAsrInference.js", () => ({
  useAsrInference: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    transcribeWindow: vi.fn(async (_pcm, _regions, options) => [
      {
        id: `segment-${options.windowIndex}`,
        text: `window ${options.windowIndex}`,
        start: options.offset,
        end: options.offset + 1,
        speaker: null,
        words: [],
      },
    ]),
    mergeSegments: vi.fn((segments) => segments),
    finalizeSegments: vi.fn(async (segments) => segments),
    cleanup: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock("./useDiarization.js", () => ({
  useDiarization: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    processWindow: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn(async (segments) => segments),
    abort: vi.fn(),
  }),
}));

vi.mock("@/lib/eventSignals.js", () => ({ trackAnalyticsEvent: vi.fn() }));

function makeStore() {
  return /** @type {any} */ ({
    file: new File([new Uint8Array([1])], "sample.mp3", { type: "audio/mpeg" }),
    fileName: "sample.mp3",
    fileSize: 1,
    fileDuration: 620,
    effectiveRuntime: "wasm",
    enableDiarization: false,
    isCancelled: false,
    segments: [],
    waveformSamples: [],
    clearProcessingState: vi.fn(),
    setSegments(segments) {
      this.segments = segments;
    },
    updateProgress: vi.fn(),
  });
}

describe("useTranscriptionPipeline uploaded media", () => {
  beforeEach(() => {
    mocks.prepared = [];
    mocks.readStarts = [];
    mocks.vadCalls = 0;
    mocks.continuousSupported = true;
    vi.clearAllMocks();
    mocks.assertStorageHeadroom.mockResolvedValue(undefined);
    mocks.beginStaging.mockResolvedValue(undefined);
    mocks.finishStaging.mockResolvedValue(undefined);
    mocks.stageFragment.mockResolvedValue(undefined);
    mocks.rollbackStaging.mockResolvedValue(undefined);
    mocks.continuousStart.mockResolvedValue(undefined);
    mocks.continuousAppend.mockResolvedValue(undefined);
    mocks.continuousFinalize.mockResolvedValue({
      version: 1,
      duration: 620,
      source: "upload",
      parts: [
        {
          index: 0,
          start: 0,
          end: 620,
          mimeType: "audio/webm;codecs=opus",
          sizeBytes: 1234,
          fragmentCount: 1,
        },
      ],
    });
    mocks.continuousCancel.mockResolvedValue(undefined);
  });

  it("uses one bounded pipeline for every window and prepares only one look-ahead", async () => {
    const store = makeStore();

    await useTranscriptionPipeline(store).start();

    expect(mocks.prepared).toEqual([0, 1, 2]);
    expect(store.updateProgress).toHaveBeenCalledWith("transcription", 0);
    expect(store.segments).toHaveLength(3);
    expect(store.waveformSamples).toHaveLength(260);
    expect(store.processPhase).toBe("complete");
    expect(mocks.closed).toHaveBeenCalledOnce();
    expect(mocks.aborted).not.toHaveBeenCalled();
  });

  it("feeds diarization committed ranges without repeating ASR overlap", async () => {
    const store = makeStore();
    store.enableDiarization = true;

    await useTranscriptionPipeline(store).start();

    expect(mocks.readStarts).toEqual([0, 297, 597, 0, 300, 600]);
    expect(store.processPhase).toBe("complete");
  });

  it("persists one continuous WebM/Opus asset from committed upload ranges when supported", async () => {
    const store = makeStore();
    const pipeline = useTranscriptionPipeline(store);

    await pipeline.start({ transcriptId: "upload-webm" });
    expect(mocks.beginStaging).toHaveBeenCalledWith("upload-webm");
    expect(mocks.continuousStart).toHaveBeenCalledOnce();
    expect(mocks.continuousAppend).toHaveBeenCalledTimes(3);
    expect(mocks.continuousFinalize).toHaveBeenCalledOnce();
    expect(mocks.stageFragment).not.toHaveBeenCalled();
    expect(pipeline.audioManifest.value).toMatchObject({
      duration: 620,
      source: "upload",
      parts: [
        { index: 0, start: 0, end: 620, mimeType: "audio/webm;codecs=opus" },
      ],
    });
    expect(store.processPhase).toBe("complete");
  });

  it("retains finalized per-window WebM proxies when continuous Opus encoding is unsupported", async () => {
    mocks.continuousSupported = false;
    const store = makeStore();
    const pipeline = useTranscriptionPipeline(store);

    await pipeline.start({ transcriptId: "upload-webm-fallback" });

    expect(mocks.continuousStart).not.toHaveBeenCalled();
    expect(mocks.stageFragment).toHaveBeenCalledTimes(3);
    expect(pipeline.audioManifest.value?.parts).toHaveLength(3);
  });

  it("falls back to finalized windows when the advertised Opus encoder cannot start", async () => {
    mocks.continuousStart.mockRejectedValueOnce(
      new Error("Opus encoder initialization failed"),
    );
    const store = makeStore();
    const pipeline = useTranscriptionPipeline(store);

    await pipeline.start({ transcriptId: "upload-webm-start-fallback" });

    expect(mocks.rollbackStaging).toHaveBeenCalledWith(
      "upload-webm-start-fallback",
    );
    expect(mocks.beginStaging).toHaveBeenCalledTimes(2);
    expect(mocks.stageFragment).toHaveBeenCalledTimes(3);
    expect(pipeline.audioManifest.value?.parts).toHaveLength(3);
  });

  it("keeps a completed transcript when continuous WebM persistence fails", async () => {
    mocks.continuousAppend.mockRejectedValueOnce(
      new Error("WebM storage unavailable"),
    );
    const store = makeStore();
    const pipeline = useTranscriptionPipeline(store);

    await pipeline.start({ transcriptId: "upload-text-only" });

    expect(store.processPhase).toBe("complete");
    expect(store.segments).toHaveLength(3);
    expect(pipeline.audioManifest.value).toBeNull();
    expect(pipeline.audioPersistenceError.value?.message).toContain(
      "WebM storage unavailable",
    );
    expect(mocks.rollbackStaging).toHaveBeenCalledWith("upload-text-only");
  });
});
