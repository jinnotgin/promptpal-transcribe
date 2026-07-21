import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrophoneCapture } from "./useMicrophoneCapture.js";

let workletNodes;

function createTrack() {
  return {
    enabled: true,
    stop: vi.fn(),
    addEventListener: vi.fn(),
  };
}

function createStream(track = createTrack()) {
  return {
    track,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
}

function installAudioMocks() {
  class MockAudioContext {
    constructor() {
      this.audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      this.createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      this.createAnalyser = vi.fn(() => ({
        fftSize: 0,
        frequencyBinCount: 1,
        getByteFrequencyData: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      this.close = vi.fn();
    }
  }
  class MockAudioWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: vi.fn((message) => {
          if (message.type === "flush" || message.type === "flush-and-stop") {
            queueMicrotask(() => {
              this.port.onmessage?.({
                data: { type: "flushed", requestId: message.requestId },
              });
            });
          }
        }),
      };
      this.disconnect = vi.fn();
      workletNodes.push(this);
    }
  }
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

describe("useMicrophoneCapture", () => {
  beforeEach(() => {
    workletNodes = [];
    installAudioMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts capture with an exact device constraint when a device id is provided", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    /** @type {any} */
    const store = { isListening: false, isPaused: false, micLevel: 0 };

    const mic = useMicrophoneCapture(store, vi.fn());
    await mic.start({ deviceId: "usb" });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: "usb" },
      },
    });
    expect(store.isListening).toBe(true);
  });

  it("does not stop the previous stream when switching fails before a new stream is acquired", async () => {
    const originalTrack = createTrack();
    const originalStream = createStream(originalTrack);
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(originalStream)
      .mockRejectedValueOnce(new DOMException("missing", "NotFoundError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    /** @type {any} */
    const store = { isListening: false, isPaused: false, micLevel: 0 };

    const mic = useMicrophoneCapture(store, vi.fn());
    await mic.start({ deviceId: "built-in" });
    await expect(mic.switchDevice({ deviceId: "usb" })).rejects.toThrow(
      "MIC_UNAVAILABLE",
    );

    expect(originalTrack.stop).not.toHaveBeenCalled();
    expect(store.isListening).toBe(true);
  });

  it("keeps a switched session paused when the switch started while paused", async () => {
    const originalTrack = createTrack();
    const nextTrack = createTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(createStream(originalTrack))
      .mockResolvedValueOnce(createStream(nextTrack));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    /** @type {any} */
    const store = { isListening: false, isPaused: false, micLevel: 0 };

    const mic = useMicrophoneCapture(store, vi.fn());
    await mic.start({ deviceId: "built-in" });
    await mic.pause();
    await mic.switchDevice({ deviceId: "usb" });

    expect(originalTrack.stop).toHaveBeenCalled();
    expect(nextTrack.enabled).toBe(false);
    expect(store.isPaused).toBe(true);
  });

  it("flushes the worklet tail before stopping the capture graph", async () => {
    const track = createTrack();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(createStream(track)),
      },
    });
    /** @type {any} */
    const store = { isListening: false, isPaused: false, micLevel: 0 };
    const mic = useMicrophoneCapture(store, vi.fn());
    await mic.start();

    await mic.flushAndStop();

    expect(workletNodes[0].port.postMessage).toHaveBeenCalledWith({
      type: "flush-and-stop",
      requestId: 1,
    });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(store.isListening).toBe(false);
  });
});
