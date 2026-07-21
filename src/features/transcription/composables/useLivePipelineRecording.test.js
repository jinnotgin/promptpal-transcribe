import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assetState = vi.hoisted(() => ({
  beginStaging: vi.fn().mockResolvedValue(undefined),
  stageFragment: vi.fn().mockResolvedValue(undefined),
  finishStaging: vi.fn().mockResolvedValue(undefined),
  rollbackStaging: vi.fn().mockResolvedValue(undefined),
  assertStorageHeadroom: vi.fn().mockResolvedValue(undefined),
}));
let captureOptions;
let microphone;

vi.mock("./useModelManager.js", () => ({
  useModelManager: () => ({ checkCache: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("./useAsrInference.js", () => ({
  useAsrInference: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    processChunk: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock("./useTranscriptionAudioAssets.js", () => ({
  useTranscriptionAudioAssets: () => assetState,
}));
vi.mock("./useMicrophoneCapture.js", () => ({
  useMicrophoneCapture: (store, _onPcm, options) => {
    captureOptions = options;
    microphone = {
      start: vi.fn(async () => {
        store.isListening = true;
        options.onStreamReady({});
      }),
      stop: vi.fn(),
      pause: vi.fn(() => {
        store.isPaused = true;
      }),
      resume: vi.fn(() => {
        store.isPaused = false;
      }),
      interrupt: vi.fn(),
      switchDevice: vi.fn(async () => options.onStreamReady({})),
      getStream: vi.fn(() => ({})),
    };
    return microphone;
  },
}));
vi.mock("@/lib/eventSignals.js", () => ({ trackAnalyticsEvent: vi.fn() }));

const { useLivePipeline } = await import("./useLivePipeline.js");

class MockWorker {
  addEventListener(_type, callback) {
    this.readyCallback = callback;
  }
  removeEventListener() {}
  postMessage(message) {
    if (message.type === "init")
      this.readyCallback?.({ data: { type: "ready" } });
  }
  terminate() {}
}

class MockMediaRecorder {
  static instances = [];
  static supportedType = "audio/webm;codecs=opus";
  static actualType = "audio/webm;codecs=opus";
  static isTypeSupported(type) {
    return type === MockMediaRecorder.supportedType;
  }
  constructor(_stream, options) {
    this.mimeType = MockMediaRecorder.actualType || options.mimeType;
    this.state = "inactive";
    this.listeners = new Map();
    MockMediaRecorder.instances.push(this);
  }
  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }
  start(timeslice) {
    this.timeslice = timeslice;
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.listeners.get("dataavailable")?.({
      data: new Blob(["audio"], { type: this.mimeType }),
    });
    this.state = "inactive";
    this.listeners.get("stop")?.();
  }
}

function createStore() {
  return {
    isListening: false,
    isPaused: false,
    isCancelled: false,
    liveElapsed: 1,
    processPhase: "idle",
    effectiveRuntime: "wasm",
    selectedMicId: "system-default",
    selectedMicLabel: "System default",
    selectedMicAvailable: true,
    micInputState: "ready",
    segments: [],
    speakerNames: {},
    speakerColors: {},
    waveformSamples: [],
    clearProcessingState() {
      this.processPhase = "idle";
      this.isCancelled = false;
    },
    clearLiveState() {
      this.isListening = false;
      this.isPaused = false;
      this.liveElapsed = null;
    },
    setMicInputState(value) {
      this.micInputState = value;
    },
    setMicInputError(value) {
      this.micInputError = value;
    },
    selectMicrophone() {},
  };
}

describe("useLivePipeline progressive native recording", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", MockWorker);
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    MockMediaRecorder.supportedType = "audio/webm;codecs=opus";
    MockMediaRecorder.actualType = "audio/webm;codecs=opus";
    MockMediaRecorder.instances = [];
    vi.clearAllMocks();
    assetState.stageFragment.mockResolvedValue(undefined);
    assetState.beginStaging.mockResolvedValue(undefined);
    assetState.finishStaging.mockResolvedValue(undefined);
    assetState.rollbackStaging.mockResolvedValue(undefined);
    assetState.assertStorageHeadroom.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists emitted WebM/Opus fragments and exposes the actual recorder MIME", async () => {
    MockMediaRecorder.actualType = "audio/webm;codecs=opus;rate=48000";
    const store = createStore();
    const pipeline = useLivePipeline(/** @type {any} */ (store));
    await pipeline.start({ transcriptId: "live-1" });
    expect(assetState.beginStaging).toHaveBeenCalledWith("live-1");
    expect(MockMediaRecorder.instances.at(-1)?.timeslice).toBe(10_000);
    expect(captureOptions.onStreamReady).toBeTypeOf("function");
    store.segments = [
      { id: "s1", start: 0, end: 0.1, text: "hello", speaker: null },
    ];

    await pipeline.stop();

    expect(assetState.stageFragment).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptId: "live-1",
        partIndex: 0,
        fragmentIndex: 0,
        blob: expect.objectContaining({
          type: "audio/webm;codecs=opus;rate=48000",
        }),
      }),
    );
    expect(pipeline.audioManifest.value).toMatchObject({
      version: 1,
      source: "live",
      parts: [
        {
          mimeType: "audio/webm;codecs=opus;rate=48000",
          fragmentCount: 1,
        },
      ],
    });
    expect("capturedPcm" in pipeline).toBe(false);
  });

  it("uses an MP4/AAC fallback when WebM and Ogg recording are unavailable", async () => {
    MockMediaRecorder.supportedType = "audio/mp4;codecs=mp4a.40.2";
    MockMediaRecorder.actualType = "audio/mp4;codecs=mp4a.40.2";
    const store = createStore();
    const pipeline = useLivePipeline(/** @type {any} */ (store));
    await pipeline.start({ transcriptId: "live-safari" });
    store.segments = [
      { id: "s1", start: 0, end: 0.1, text: "hello", speaker: null },
    ];

    await pipeline.stop();

    expect(pipeline.audioManifest.value).toMatchObject({
      parts: [{ mimeType: "audio/mp4;codecs=mp4a.40.2" }],
    });
  });

  it("finalizes one native part before switching microphones", async () => {
    const store = createStore();
    const pipeline = useLivePipeline(/** @type {any} */ (store));
    await pipeline.start({ transcriptId: "live-switch" });

    await pipeline.switchInput("mic-2");
    store.segments = [
      { id: "s1", start: 0, end: 0.1, text: "hello", speaker: null },
    ];
    await pipeline.stop();

    expect(assetState.stageFragment).toHaveBeenCalledTimes(2);
    expect(pipeline.audioManifest.value?.parts).toHaveLength(2);
  });

  it("keeps transcript text and rolls back fragments when native persistence fails", async () => {
    assetState.stageFragment.mockRejectedValueOnce(
      new Error("native storage failed"),
    );
    const store = createStore();
    const pipeline = useLivePipeline(/** @type {any} */ (store));
    await pipeline.start({ transcriptId: "live-text-only" });
    store.segments = [
      { id: "s1", start: 0, end: 0.1, text: "hello", speaker: null },
    ];

    await pipeline.stop();

    expect(store.processPhase).toBe("complete");
    expect(pipeline.audioManifest.value).toBeNull();
    expect(pipeline.audioPersistenceError.value?.message).toContain(
      "native storage failed",
    );
    expect(assetState.rollbackStaging).toHaveBeenCalledWith("live-text-only");
  });

  it("keeps delayed writes and rollback bound to the cancelled recording session", async () => {
    /** @type {(value?: unknown) => void} */
    let releaseFirstWrite = () => {};
    assetState.stageFragment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstWrite = resolve;
        }),
    );
    const store = createStore();
    const pipeline = useLivePipeline(/** @type {any} */ (store));
    await pipeline.start({ transcriptId: "live-a" });

    pipeline.cancel();
    await pipeline.start({ transcriptId: "live-b" });
    await vi.waitFor(() =>
      expect(assetState.stageFragment).toHaveBeenCalledTimes(1),
    );

    expect(assetState.stageFragment).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptId: "live-a" }),
    );
    releaseFirstWrite();
    await vi.waitFor(() =>
      expect(assetState.rollbackStaging).toHaveBeenCalledWith("live-a"),
    );
    expect(assetState.rollbackStaging).not.toHaveBeenCalledWith("live-b");

    pipeline.cancel();
  });
});
