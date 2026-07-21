import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceActivityDetection } from "./useVoiceActivityDetection.js";

class FakeVadWorker {
  static instances = [];
  static autoRespond = true;

  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    FakeVadWorker.instances.push(this);
  }

  postMessage(message) {
    if (message.type !== "process" || !FakeVadWorker.autoRespond) return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          type: "complete",
          payload: {
            regions: [{ start: 1, end: 2 }],
            pcmData: message.payload.pcmData,
          },
        },
      });
    });
  }

  terminate() {
    this.terminated = true;
  }
}

describe("useVoiceActivityDetection", () => {
  beforeEach(() => {
    FakeVadWorker.instances = [];
    FakeVadWorker.autoRespond = true;
    vi.stubGlobal("Worker", FakeVadWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips ownership of a bounded PCM window", async () => {
    const vad = useVoiceActivityDetection();
    const pcm = new Float32Array([0, 0.25, 0.5]);

    const result = await vad.detectWindow(pcm);

    expect(result.regions).toEqual([{ start: 1, end: 2 }]);
    expect(result.pcm).toEqual(new Float32Array([0, 0.25, 0.5]));
  });

  it("rejects the active detection and permits a clean retry after cancellation", async () => {
    const vad = useVoiceActivityDetection();
    FakeVadWorker.autoRespond = false;
    const pending = vad.detectWindow(new Float32Array([0, 1]));

    vad.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeVadWorker.instances[0].terminated).toBe(true);

    FakeVadWorker.autoRespond = true;
    await expect(
      vad.detectWindow(new Float32Array([1, 0])),
    ).resolves.toMatchObject({
      regions: [{ start: 1, end: 2 }],
    });
    expect(FakeVadWorker.instances).toHaveLength(2);
  });
});
