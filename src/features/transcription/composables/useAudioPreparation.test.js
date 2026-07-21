import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioPreparation } from "./useAudioPreparation.js";

class FakeWorker {
  static instances = [];
  static autoRespond = true;

  constructor() {
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    if (!FakeWorker.autoRespond && message.type === "prepare-window") return;
    queueMicrotask(() => {
      if (message.type === "open-file") {
        this.onmessage?.({
          data: {
            type: "file-opened",
            requestId: message.requestId,
            payload: { duration: 12 },
          },
        });
      }
      if (message.type === "prepare-window") {
        const pcm = new Float32Array([0, 0.5, -0.5, 1]);
        this.onmessage?.({
          data: {
            type: "window-complete",
            requestId: message.requestId,
            payload: { pcmData: pcm.buffer },
          },
        });
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

describe("useAudioPreparation", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.autoRespond = true;
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the original file to one reusable bounded preparation session", async () => {
    const preparation = useAudioPreparation();
    const file = new File([new Uint8Array([1, 2, 3])], "sample.mp3", {
      type: "audio/mpeg",
    });
    file.arrayBuffer = vi.fn(() => {
      throw new Error("complete file reads are forbidden");
    });

    await expect(preparation.open(file, 12)).resolves.toEqual({ duration: 12 });
    await expect(
      preparation.prepareWindow({
        readStart: 0,
        readEnd: 12,
        index: 0,
        total: 1,
      }),
    ).resolves.toEqual(new Float32Array([0, 0.5, -0.5, 1]));

    const worker = FakeWorker.instances[0];
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.messages[0]).toMatchObject({
      type: "open-file",
      payload: { file, duration: 12 },
    });
    expect(worker.messages[1]).toMatchObject({
      type: "prepare-window",
      payload: { start: 0, duration: 12, windowIndex: 0 },
    });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it("terminates the worker and rejects pending requests on abort", async () => {
    const preparation = useAudioPreparation();
    const file = new File([new Uint8Array([1])], "sample.mp3", {
      type: "audio/mpeg",
    });
    await preparation.open(file, 12);
    FakeWorker.autoRespond = false;
    const pending = preparation.prepareWindow({
      readStart: 0,
      readEnd: 12,
      index: 0,
      total: 1,
    });

    preparation.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances[0].terminated).toBe(true);

    FakeWorker.autoRespond = true;
    await preparation.open(file, 12);
    await expect(
      preparation.prepareWindow({
        readStart: 0,
        readEnd: 12,
        index: 0,
        total: 1,
      }),
    ).resolves.toHaveLength(4);
    expect(FakeWorker.instances).toHaveLength(2);
  });
});
