import { describe, expect, it, vi } from "vitest";
import { createSenseVoiceRecognizer } from "./senseVoiceRecognizer.js";

const META = {
  lfrWindowSize: 7,
  lfrWindowShift: 6,
  negMean: new Float32Array(560),
  invStddev: new Float32Array(560).fill(1),
  languageIds: { auto: 0, zh: 3, en: 4 },
  withItn: 14,
  withoutItn: 15,
  vocabSize: 6,
};
const SYMBOLS = [
  "<unk>",
  "<|zh|>",
  "<|NEUTRAL|>",
  "<|Speech|>",
  "<|withitn|>",
  "好",
];

class FakeTensor {
  /**
   * @param {string} type
   * @param {ArrayLike<number>} data
   * @param {number[]} dims
   */
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

function fakeSession() {
  return {
    inputNames: ["x", "x_length", "language", "text_norm"],
    outputNames: ["logits"],
    run: vi.fn(async (/** @type {Record<string, FakeTensor>} */ feeds) => {
      const frames = feeds.x.dims[1] + 4;
      const logits = new Float32Array(frames * 6);
      // Prompt tags on frames 0-3, "好" on audio frame 2.
      [1, 2, 3, 4].forEach((id, t) => (logits[t * 6 + id] = 1));
      logits[6 * 6 + 5] = 1;
      return { logits: new FakeTensor("float32", logits, [1, frames, 6]) };
    }),
    release: vi.fn(),
  };
}

describe("createSenseVoiceRecognizer", () => {
  it("feeds features with the language and ITN prompt and decodes words", async () => {
    const session = fakeSession();
    const recognizer = createSenseVoiceRecognizer({
      session,
      Tensor: FakeTensor,
      metadata: META,
      symbols: SYMBOLS,
      language: "auto",
    });
    const result = await recognizer.transcribe(new Float32Array(16000), 5);

    const feeds = session.run.mock.calls[0][0];
    expect(feeds.x.dims).toEqual([1, 17, 560]);
    expect(Array.from(feeds.x_length.data)).toEqual([17]);
    expect(Array.from(feeds.language.data)).toEqual([0]);
    expect(Array.from(feeds.text_norm.data)).toEqual([14]);
    expect(result.language).toBe("zh");
    expect(result.words).toEqual([{ text: "好", start: 5.12, end: 5.52 }]);
  });

  it("asks for a fixed language when one is chosen", async () => {
    const session = fakeSession();
    const recognizer = createSenseVoiceRecognizer({
      session,
      Tensor: FakeTensor,
      metadata: META,
      symbols: SYMBOLS,
      language: "zh",
    });
    await recognizer.transcribe(new Float32Array(16000), 0);
    expect(Array.from(session.run.mock.calls[0][0].language.data)).toEqual([3]);
  });

  it("skips the model for audio too short to make one feature frame", async () => {
    const session = fakeSession();
    const recognizer = createSenseVoiceRecognizer({
      session,
      Tensor: FakeTensor,
      metadata: META,
      symbols: SYMBOLS,
    });
    const result = await recognizer.transcribe(new Float32Array(100), 0);
    expect(session.run).not.toHaveBeenCalled();
    expect(result.words).toEqual([]);
  });
});
