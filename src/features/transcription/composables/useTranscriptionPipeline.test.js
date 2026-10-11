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
  events: /** @type {string[]} */ ([]),
  regionCalls: /** @type {any[]} */ ([]),
  alignFails: false,
  alignedPcmLengths: /** @type {number[]} */ ([]),
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
    ensureModelsReady: vi.fn().mockResolvedValue(undefined),
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
      if (mocks.vadCalls === 0)
        expect(mocks.prepared.slice(-2)).toEqual([0, 1]);
      mocks.vadCalls += 1;
      return { regions: [{ start: 0, end: 1, preChunked: true }], pcm };
    }),
    detect: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock("./useAsrInference.js", () => ({
  useAsrInference: () => ({
    initialize: vi.fn(async (_runtime, engine) => {
      mocks.events.push(`asr-init:${engine?.engine ?? "parakeet"}`);
    }),
    transcribeRegions: vi.fn(async (_pcm, regions, options) => {
      mocks.regionCalls.push({ regions, options });
      return regions.map((region, index) => {
        const row = {
          id: `qwen-${options.windowIndex}-${index}`,
          text: "你好。",
          start: region.start,
          end: region.end,
          speaker: region.speakerId ? `Speaker ${region.speakerId}` : null,
          words: [],
        };
        options.onRegion?.(region, [row]);
        return row;
      });
    }),
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
    cleanup: vi.fn(() => mocks.events.push("asr-cleanup")),
    abort: vi.fn(),
  }),
}));

vi.mock("./useForcedAlignment.js", () => ({
  useForcedAlignment: () => ({
    initialize: vi.fn(async () => {
      mocks.events.push("aligner-init");
    }),
    alignRegion: vi.fn(async (pcm, job) => {
      mocks.events.push(`align:${job.start}`);
      mocks.alignedPcmLengths.push(pcm.length);
      if (mocks.alignFails) throw new Error("WebGPU out of memory");
      return [
        {
          text: job.text,
          start: job.start + 0.2,
          end: job.end - 0.1,
          speaker: job.speaker,
          words: [{ text: "你", start: job.start + 0.2, end: job.start + 0.5 }],
        },
      ];
    }),
    cleanup: vi.fn(() => mocks.events.push("aligner-cleanup")),
    abort: vi.fn(),
  }),
}));

vi.mock("./useDiarization.js", () => ({
  useDiarization: () => ({
    initialize: vi.fn(async (_runtime, engine) => {
      mocks.events.push(`diarization-init:${engine?.engine}`);
    }),
    processWindow: vi.fn(async () => {
      mocks.events.push("diarization-window");
    }),
    finalize: vi.fn(async (segments) => segments),
    finalizeTurns: vi.fn(async () => {
      mocks.events.push("diarization-turns");
      return [{ id: 2, start: 0, end: 620 }];
    }),
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
    language: "en",
    enableDiarization: false,
    shaderF16: true,
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
    mocks.events = [];
    mocks.regionCalls = [];
    mocks.alignFails = false;
    mocks.alignedPcmLengths = [];
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

  it("diarizes Chinese first, then transcribes speaker-labelled Qwen regions", async () => {
    const store = makeStore();
    store.language = "zh";
    store.effectiveRuntime = "webgpu";
    store.enableDiarization = true;

    await useTranscriptionPipeline(store).start();

    expect(mocks.events).toEqual([
      "diarization-init:nemotron",
      "diarization-window",
      "diarization-window",
      "diarization-window",
      "diarization-turns",
      "asr-init:qwen3-asr",
      "asr-cleanup",
      "aligner-init",
      "align:0",
      "aligner-cleanup",
    ]);
    // Each mocked window is 1 s of PCM, so only window 0 has committed speech.
    expect(mocks.regionCalls).toHaveLength(1);
    expect(mocks.regionCalls[0].regions).toEqual([
      { start: 0, end: 1, speakerId: 2 },
    ]);
    expect(mocks.alignedPcmLengths).toEqual([16000]);
    expect(store.segments).toEqual([
      expect.objectContaining({
        text: "你好。",
        speaker: "Speaker 2",
        start: 0.2,
        words: [{ text: "你", start: 0.2, end: 0.5 }],
      }),
    ]);
    expect(store.processPhase).toBe("complete");
  });

  it("keeps proportional Chinese timings when alignment fails", async () => {
    mocks.alignFails = true;
    const store = makeStore();
    store.language = "zh";
    store.effectiveRuntime = "webgpu";

    await useTranscriptionPipeline(store).start();

    expect(mocks.events).toContain("aligner-cleanup");
    expect(store.segments).toEqual([
      expect.objectContaining({ text: "你好。", start: 0, end: 1 }),
    ]);
    expect(store.processPhase).toBe("complete");
  });

  it("uses the large-group diarizer with the chosen speaker count", async () => {
    const store = makeStore();
    store.enableDiarization = true;
    store.speakerScale = "large";
    store.speakerCount = 12;

    await useTranscriptionPipeline(store).start();

    expect(mocks.events).toContain("diarization-init:sherpa");
    expect(mocks.events).not.toContain("aligner-init");
    expect(store.processPhase).toBe("complete");
  });

  it("refuses Chinese transcription without WebGPU", async () => {
    const store = makeStore();
    store.language = "zh";

    await useTranscriptionPipeline(store).start();

    expect(store.processPhase).toBe("error");
    expect(store.error.code).toBe("ENGINE_UNAVAILABLE");
    expect(mocks.events).toEqual([]);
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
