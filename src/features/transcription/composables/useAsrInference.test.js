import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAsrInference } from "./useAsrInference.js";

class FakeAsrWorker {
  static instances = [];
  static autoRespond = true;

  constructor() {
    this.listeners = new Set();
    this.onerror = null;
    this.terminated = false;
    FakeAsrWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message) {
    if (!FakeAsrWorker.autoRespond) return;
    queueMicrotask(() => {
      if (message.type === "init") this.emit({ type: "ready" });
      if (message.type === "process") {
        const start = message.payload.chunkStart;
        this.emit({
          type: "progress",
          payload: {
            percent:
              ((message.payload.chunkIndex + 1) / message.payload.totalChunks) *
              100,
          },
        });
        this.emit({
          type: "partial",
          payload: {
            segments: [
              {
                text: "hello",
                start,
                end: start + 1,
                words: [{ text: "hello", start, end: start + 1 }],
              },
            ],
          },
        });
      }
    });
  }

  emit(data) {
    for (const listener of [...this.listeners]) listener({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

describe("useAsrInference window sessions", () => {
  beforeEach(() => {
    FakeAsrWorker.instances = [];
    FakeAsrWorker.autoRespond = true;
    vi.stubGlobal("Worker", FakeAsrWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps one ASR worker alive across absolute-timestamped PCM windows", async () => {
    const store = /** @type {any} */ ({
      isCancelled: false,
      enableDiarization: true,
      setSegments: vi.fn(),
      updateProgress: vi.fn(),
    });
    const asr = useAsrInference(store);
    await asr.initialize("wasm");

    const rows = await asr.transcribeWindow(
      new Float32Array(16000 * 2),
      [{ start: 0, end: 2, preChunked: true }],
      { offset: 300, windowIndex: 1, totalWindows: 3 },
    );

    expect(rows[0]).toMatchObject({ text: "hello", start: 300, end: 301 });
    expect(FakeAsrWorker.instances).toHaveLength(1);
    expect(FakeAsrWorker.instances[0].terminated).toBe(false);

    asr.cleanup();
    expect(FakeAsrWorker.instances[0].terminated).toBe(true);
  });

  it("deduplicates matching word emissions from preparation-window overlap", () => {
    const asr = useAsrInference(
      /** @type {any} */ ({ updateProgress: vi.fn(), isCancelled: false }),
    );
    const rows = asr.mergeSegments([
      {
        id: "left",
        text: "boundary phrase",
        start: 298,
        end: 300,
        speaker: null,
        words: [
          { text: "boundary", start: 298, end: 299 },
          { text: "phrase", start: 299, end: 300 },
        ],
      },
      {
        id: "right",
        text: "phrase continues",
        start: 299.04,
        end: 301,
        speaker: null,
        words: [
          { text: "phrase", start: 299.04, end: 300.02 },
          { text: "continues", start: 300.1, end: 301 },
        ],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("boundary phrase continues");
    expect(rows[0].words).toHaveLength(3);
  });

  it("keeps aggregate transcription progress monotonic across windows with different chunk counts", async () => {
    const store = /** @type {any} */ ({
      isCancelled: false,
      enableDiarization: false,
      updateProgress: vi.fn(),
    });
    const asr = useAsrInference(store);
    await asr.initialize("wasm");

    await asr.transcribeWindow(
      new Float32Array(16000 * 2),
      [
        { start: 0, end: 1, preChunked: true },
        { start: 1, end: 2, preChunked: true },
      ],
      { windowIndex: 0, totalWindows: 2 },
    );
    await asr.transcribeWindow(
      new Float32Array(16000),
      [{ start: 0, end: 1, preChunked: true }],
      {
        offset: 300,
        windowIndex: 1,
        totalWindows: 2,
      },
    );

    const percentages = store.updateProgress.mock.calls
      .filter(([phase]) => phase === "transcription")
      .map(([, percent]) => percent);
    expect(percentages).toEqual([25, 50, 100]);
    expect(percentages).toEqual(
      [...percentages].sort((left, right) => left - right),
    );
    asr.cleanup();
  });

  it("rejects active inference and permits a fresh worker after cancellation", async () => {
    const store = /** @type {any} */ ({
      isCancelled: false,
      enableDiarization: false,
      updateProgress: vi.fn(),
    });
    const asr = useAsrInference(store);
    await asr.initialize("wasm");
    FakeAsrWorker.autoRespond = false;
    const pending = asr.transcribeWindow(new Float32Array(16000), [
      { start: 0, end: 1, preChunked: true },
    ]);

    asr.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeAsrWorker.instances[0].terminated).toBe(true);

    FakeAsrWorker.autoRespond = true;
    await asr.initialize("wasm");
    await expect(
      asr.transcribeWindow(new Float32Array(16000), [
        { start: 0, end: 1, preChunked: true },
      ]),
    ).resolves.toHaveLength(1);
    expect(FakeAsrWorker.instances).toHaveLength(2);
    asr.cleanup();
  });
});
