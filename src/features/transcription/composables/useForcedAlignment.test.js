import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForcedAlignment } from "./useForcedAlignment.js";

class FakeAlignerWorker {
  /** @type {FakeAlignerWorker[]} */
  static instances = [];
  static failAlign = false;

  constructor(url) {
    this.url = String(url);
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    /** @type {any[]} */
    this.messages = [];
    FakeAlignerWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => {
      if (message.type === "init") this.reply(message, "ready", {});
      if (message.type === "align") {
        if (FakeAlignerWorker.failAlign) {
          this.reply(message, "error", { message: "out of memory" });
          return;
        }
        this.reply(message, "aligned", {
          segments: [
            {
              text: message.payload.text,
              start: message.payload.start,
              end: message.payload.start + 1,
              speaker: message.payload.speaker,
              words: [],
            },
          ],
        });
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

describe("useForcedAlignment", () => {
  beforeEach(() => {
    FakeAlignerWorker.instances = [];
    FakeAlignerWorker.failAlign = false;
    vi.stubGlobal("Worker", FakeAlignerWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("aligns regions in one worker and transfers their audio", async () => {
    const alignment = useForcedAlignment();
    await alignment.initialize();
    const pcm = new Float32Array(16000);
    const segments = await alignment.alignRegion(pcm, {
      start: 3,
      end: 4,
      speaker: "Speaker B",
      text: "你好",
      rowIds: ["x"],
    });
    expect(segments).toEqual([
      { text: "你好", start: 3, end: 4, speaker: "Speaker B", words: [] },
    ]);
    const worker = FakeAlignerWorker.instances[0];
    expect(worker.url).toContain("qwenAlignerWorker");
    expect(worker.messages[1]).toMatchObject({
      type: "align",
      payload: { text: "你好", start: 3, speaker: "Speaker B" },
    });
    alignment.cleanup();
    expect(worker.terminated).toBe(true);
  });

  it("rejects with the worker's error", async () => {
    FakeAlignerWorker.failAlign = true;
    const alignment = useForcedAlignment();
    await alignment.initialize();
    await expect(
      alignment.alignRegion(new Float32Array(10), {
        start: 0,
        end: 1,
        speaker: null,
        text: "好",
        rowIds: [],
      }),
    ).rejects.toThrow(/out of memory/);
  });

  it("rejects pending work on abort", async () => {
    const alignment = useForcedAlignment();
    const pending = alignment.initialize();
    alignment.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
