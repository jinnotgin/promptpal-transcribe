import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockMic;
let mockCaptureOptions;

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

vi.mock("./useMicrophoneCapture.js", () => ({
  useMicrophoneCapture: (_store, _onPcmChunk, options) => {
    mockCaptureOptions = options;
    return mockMic;
  },
}));

vi.mock("@/lib/eventSignals.js", () => ({
  trackAnalyticsEvent: vi.fn(),
}));

const { useLivePipeline } = await import("./useLivePipeline.js");

class MockWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }
  addEventListener(_type, callback) {
    this.readyCallback = callback;
  }
  removeEventListener() {}
  postMessage(message) {
    if (message.type === "init") {
      this.readyCallback?.({ data: { type: "ready" } });
    }
  }
  terminate() {}
}

/** @returns {any} */
function createStore() {
  return {
    isListening: false,
    isPaused: false,
    isCancelled: false,
    micLevel: 0,
    liveElapsed: null,
    processPhase: "idle",
    effectiveRuntime: "wasm",
    selectedMicId: "built-in",
    selectedMicLabel: "Built-in Microphone",
    selectedMicAvailable: true,
    availableMics: [
      { deviceId: "built-in", label: "Built-in Microphone", available: true },
      { deviceId: "usb", label: "USB Microphone", available: true },
    ],
    micInputState: "ready",
    micInputError: null,
    segments: [{ id: "seg-1", start: 0, end: 1, text: "hello" }],
    speakerNames: {},
    speakerColors: {},
    clearProcessingState() {
      this.processPhase = "idle";
      this.isCancelled = false;
      this.micInputError = null;
    },
    clearLiveState() {
      this.isListening = false;
      this.isPaused = false;
      this.liveElapsed = null;
      this.micLevel = 0;
    },
    selectMicrophone(deviceId) {
      this.selectedMicId = deviceId || "system-default";
      const mic = this.availableMics.find(
        (candidate) => candidate.deviceId === this.selectedMicId,
      );
      this.selectedMicLabel = mic?.label || "System default";
      this.selectedMicAvailable = mic?.available !== false;
    },
    setMicInputState(state) {
      this.micInputState = state;
    },
    setMicInputError(error) {
      this.micInputError = error;
    },
  };
}

describe("useLivePipeline microphone switching", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", MockWorker);
    mockMic = {
      start: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      interrupt: vi.fn(),
      switchDevice: vi.fn(async () => {}),
    };
    mockCaptureOptions = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("switches input while listening without clearing the current transcript session", async () => {
    const store = createStore();
    mockMic.start.mockImplementation(async () => {
      store.isListening = true;
      store.isPaused = false;
    });
    const pipeline = useLivePipeline(store);
    await pipeline.start();
    store.segments = [{ id: "seg-1", start: 0, end: 1, text: "hello" }];
    const existingSegments = store.segments;

    await pipeline.switchInput("usb");

    expect(mockMic.switchDevice).toHaveBeenCalledWith({ deviceId: "usb" });
    expect(store.isListening).toBe(true);
    expect(store.segments).toBe(existingSegments);
    expect(store.selectedMicId).toBe("usb");
    expect(store.micInputState).toBe("ready");
  });

  it("switches input while paused and keeps the session paused", async () => {
    const store = createStore();
    mockMic.start.mockImplementation(async () => {
      store.isListening = true;
      store.isPaused = false;
    });
    const pipeline = useLivePipeline(store);
    await pipeline.start();
    pipeline.pause();
    store.isPaused = true;

    await pipeline.switchInput("usb");

    expect(mockMic.switchDevice).toHaveBeenCalledWith({ deviceId: "usb" });
    expect(store.isPaused).toBe(true);
    expect(store.selectedMicId).toBe("usb");
  });

  it("restores previous selection and reports inline error when switch fails", async () => {
    const store = createStore();
    mockMic.start.mockImplementation(async () => {
      store.isListening = true;
      store.isPaused = false;
    });
    const pipeline = useLivePipeline(store);
    await pipeline.start();
    mockMic.switchDevice.mockRejectedValueOnce(new Error("MIC_UNAVAILABLE"));

    await expect(pipeline.switchInput("usb")).rejects.toThrow(
      "MIC_UNAVAILABLE",
    );

    expect(store.selectedMicId).toBe("built-in");
    expect(store.selectedMicLabel).toBe("Built-in Microphone");
    expect(store.micInputState).toBe("ready");
    expect(store.micInputError).toMatchObject({ code: "MIC_SWITCH_FAILED" });
  });

  it("restores ready input state when a paused switch fails but the previous mic is available", async () => {
    const store = createStore();
    mockMic.start.mockImplementation(async () => {
      store.isListening = true;
      store.isPaused = false;
    });
    const pipeline = useLivePipeline(store);
    await pipeline.start();
    pipeline.pause();
    store.isPaused = true;
    mockMic.switchDevice.mockRejectedValueOnce(new Error("MIC_UNAVAILABLE"));

    await expect(pipeline.switchInput("usb")).rejects.toThrow(
      "MIC_UNAVAILABLE",
    );

    expect(store.selectedMicId).toBe("built-in");
    expect(store.isPaused).toBe(true);
    expect(store.micInputState).toBe("ready");
  });

  it("marks the session interrupted when the active microphone ends", async () => {
    const store = createStore();
    mockMic.start.mockImplementation(async () => {
      store.isListening = true;
      store.isPaused = false;
    });
    const pipeline = useLivePipeline(store);
    await pipeline.start();

    mockCaptureOptions.onEnded();

    expect(mockMic.interrupt).toHaveBeenCalled();
    expect(store.isListening).toBe(true);
    expect(store.micInputState).toBe("interrupted");
    expect(store.micInputError).toMatchObject({ code: "MIC_DISCONNECTED" });
  });

  it("blocks resume when the selected microphone is unavailable", async () => {
    const store = createStore();
    mockMic.start.mockImplementation(async () => {
      store.isListening = true;
      store.isPaused = false;
    });
    const pipeline = useLivePipeline(store);
    await pipeline.start();
    store.selectedMicAvailable = false;

    pipeline.resume();

    expect(mockMic.resume).not.toHaveBeenCalled();
    expect(store.micInputState).toBe("unavailable");
    expect(store.micInputError).toMatchObject({ code: "MIC_UNAVAILABLE" });
  });
});
