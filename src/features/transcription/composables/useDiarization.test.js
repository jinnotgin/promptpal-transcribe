import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiarization } from "./useDiarization.js";

class FakeDiarizationWorker {
  static instances = [];
  static autoRespond = true;

  constructor(url) {
    this.url = String(url);
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this.messages = [];
    FakeDiarizationWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    if (!FakeDiarizationWorker.autoRespond && message.type === "process-window")
      return;
    queueMicrotask(() => {
      if (message.type === "init") this.reply(message, "ready", {});
      if (message.type === "process-window")
        this.reply(message, "window-complete", {});
      if (message.type === "finalize") {
        this.reply(
          message,
          "complete",
          message.payload.mode === "turns"
            ? { turns: [{ id: 1, start: 0, end: 2 }] }
            : { segments: message.payload.segments },
        );
      }
    });
  }

  reply(message, type, payload) {
    this.onmessage?.({ data: { type, requestId: message.requestId, payload } });
  }

  terminate() {
    this.terminated = true;
  }
}

describe("useDiarization window sessions", () => {
  beforeEach(() => {
    FakeDiarizationWorker.instances = [];
    FakeDiarizationWorker.autoRespond = true;
    vi.stubGlobal("Worker", FakeDiarizationWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reuses one worker across bounded PCM windows and finalizes once", async () => {
    const diarization = useDiarization(
      /** @type {any} */ ({
        updateProgress: vi.fn(),
        sortformerLoadProgress: 0,
      }),
    );
    await diarization.initialize("wasm");
    await diarization.processWindow(new Float32Array([0, 1]), {
      windowIndex: 0,
      totalWindows: 2,
    });
    await diarization.processWindow(new Float32Array([1, 0]), {
      windowIndex: 1,
      totalWindows: 2,
    });
    const segments = [
      { id: "1", text: "hello", start: 0, end: 1, speaker: null, words: [] },
    ];

    await expect(diarization.finalize(segments)).resolves.toEqual(segments);

    const worker = FakeDiarizationWorker.instances[0];
    expect(FakeDiarizationWorker.instances).toHaveLength(1);
    expect(worker.messages.map((message) => message.type)).toEqual([
      "init",
      "process-window",
      "process-window",
      "finalize",
    ]);
    expect(worker.terminated).toBe(true);
  });

  it("rejects active work and can initialize a clean session after cancellation", async () => {
    const diarization = useDiarization(
      /** @type {any} */ ({
        updateProgress: vi.fn(),
        sortformerLoadProgress: 0,
      }),
    );
    await diarization.initialize("wasm");
    FakeDiarizationWorker.autoRespond = false;
    const pending = diarization.processWindow(new Float32Array([0, 1]), {
      windowIndex: 0,
      totalWindows: 1,
    });

    diarization.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeDiarizationWorker.instances[0].terminated).toBe(true);

    FakeDiarizationWorker.autoRespond = true;
    await diarization.initialize("wasm");
    await expect(
      diarization.processWindow(new Float32Array([1, 0]), {
        windowIndex: 0,
        totalWindows: 1,
      }),
    ).resolves.toBeUndefined();
    expect(FakeDiarizationWorker.instances).toHaveLength(2);
    diarization.abort();
  });

  it("runs the Nemotron worker by default and the legacy worker on request", async () => {
    const store = /** @type {any} */ ({
      updateProgress: vi.fn(),
      sortformerLoadProgress: 0,
    });
    const diarization = useDiarization(store);
    await diarization.initialize("wasm");
    await diarization.initialize("wasm", {
      engine: "sortformer",
      variant: "fp32",
      maxSpeakers: 4,
    });

    expect(FakeDiarizationWorker.instances[0].url).toContain(
      "nemotronDiarizationWorker",
    );
    expect(FakeDiarizationWorker.instances[1].url).toContain(
      "/diarizationWorker",
    );
  });

  it("runs the sherpa worker with the requested speaker count", async () => {
    const diarization = useDiarization(
      /** @type {any} */ ({
        updateProgress: vi.fn(),
        sortformerLoadProgress: 0,
      }),
    );
    await diarization.initialize("webgpu", {
      engine: "sherpa",
      variant: "campplus",
      numSpeakers: 12,
    });
    const worker = FakeDiarizationWorker.instances[0];
    expect(worker.url).toContain("sherpaDiarizationWorker");
    expect(worker.messages[0]).toMatchObject({
      type: "init",
      payload: { runtime: "webgpu", numSpeakers: 12 },
    });
    diarization.abort();
  });

  it("returns speaker turns for diarize-first transcription", async () => {
    const diarization = useDiarization(
      /** @type {any} */ ({
        updateProgress: vi.fn(),
        sortformerLoadProgress: 0,
      }),
    );
    await diarization.initialize("wasm");
    await diarization.processWindow(new Float32Array([0, 1]), {
      windowIndex: 0,
      totalWindows: 1,
    });

    await expect(diarization.finalizeTurns()).resolves.toEqual([
      { id: 1, start: 0, end: 2 },
    ]);
    const worker = FakeDiarizationWorker.instances[0];
    expect(worker.messages.at(-1)).toMatchObject({
      type: "finalize",
      payload: { mode: "turns" },
    });
    expect(worker.terminated).toBe(true);
  });
});
