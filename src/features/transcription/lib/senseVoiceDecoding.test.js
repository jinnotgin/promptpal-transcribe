import { describe, expect, it } from "vitest";
import {
  ctcGreedyDecode,
  decodeSenseVoiceTokens,
  parseTokens,
} from "./senseVoiceDecoding.js";

/**
 * One-hot logits: frame t peaks at ids[t].
 * @param {number[]} ids
 * @param {number} vocab
 */
function logitsFor(ids, vocab) {
  const logits = new Float32Array(ids.length * vocab);
  ids.forEach((id, t) => {
    logits[t * vocab + id] = 1;
  });
  return logits;
}

const SYMBOLS = [
  "<unk>", // 0, blank
  "<|zh|>",
  "<|NEUTRAL|>",
  "<|Speech|>",
  "<|withitn|>",
  "开",
  "饭",
  "9",
  "点",
  "。",
  "▁The",
  "▁tri",
  "bal",
  "▁chief",
  ".",
  "<|en|>",
  "▁", // 16
  "5",
  "0",
];

describe("parseTokens", () => {
  it("maps ids to symbols from sherpa-onnx tokens.txt", () => {
    expect(parseTokens("<unk> 0\n<s> 1\n▁the 3\n")).toEqual([
      "<unk>",
      "<s>",
      undefined,
      "▁the",
    ]);
  });
});

describe("ctcGreedyDecode", () => {
  it("collapses repeats, drops blanks and records each token's first frame", () => {
    const { ids, frames } = ctcGreedyDecode(
      logitsFor([1, 1, 0, 5, 5, 0, 5, 6], 16),
      8,
      16,
    );
    expect(ids).toEqual([1, 5, 5, 6]);
    expect(frames).toEqual([0, 3, 6, 7]);
  });
});

describe("decodeSenseVoiceTokens", () => {
  // Frames 0-3 carry the four prompt tags; audio frame k is model frame k + 4.
  const prompt = { ids: [1, 2, 3, 4], frames: [0, 1, 2, 3] };

  it("reads the prompt tags and times Chinese characters as words", () => {
    const result = decodeSenseVoiceTokens(
      {
        ids: [...prompt.ids, 5, 6, 7, 8, 9],
        frames: [...prompt.frames, 14, 18, 30, 35, 40],
      },
      SYMBOLS,
      { offsetSeconds: 10, durationSeconds: 3 },
    );
    expect(result.language).toBe("zh");
    expect(result.emotion).toBe("NEUTRAL");
    expect(result.event).toBe("Speech");
    expect(result.text).toBe("开饭9点。");
    expect(result.words.map((word) => word.text)).toEqual([
      "开",
      "饭",
      "9",
      "点。",
    ]);
    // (frame - 4) * 60 ms + offset.
    expect(result.words[0].start).toBeCloseTo(10.6);
    expect(result.words[1].start).toBeCloseTo(10.84);
    expect(result.words[2].start).toBeCloseTo(11.56);
    // A word ends where the next begins.
    expect(result.words[0].end).toBeCloseTo(10.84);
  });

  it("merges English word pieces on the ▁ boundary", () => {
    const result = decodeSenseVoiceTokens(
      {
        ids: [15, 2, 3, 4, 10, 11, 12, 13, 14],
        frames: [0, 1, 2, 3, 19, 26, 30, 35, 40],
      },
      SYMBOLS,
      { offsetSeconds: 0, durationSeconds: 5 },
    );
    expect(result.language).toBe("en");
    expect(result.words.map((word) => word.text)).toEqual([
      "The",
      "tribal",
      "chief.",
    ]);
    expect(result.text).toBe("The tribal chief.");
    expect(result.words[1].start).toBeCloseTo(1.32);
  });

  it("treats a standalone ▁ token as a word boundary", () => {
    const result = decodeSenseVoiceTokens(
      {
        ids: [15, 2, 3, 4, 10, 16, 17, 18],
        frames: [0, 1, 2, 3, 10, 13, 16, 19],
      },
      SYMBOLS,
      { offsetSeconds: 0, durationSeconds: 2 },
    );
    expect(result.words.map((word) => word.text)).toEqual(["The", "50"]);
    expect(result.text).toBe("The 50");
    // The number starts at its first digit, not at the space token.
    expect(result.words[1].start).toBeCloseTo(0.72);
  });

  it("caps a word's tail before a long pause and at the chunk end", () => {
    const result = decodeSenseVoiceTokens(
      { ids: [...prompt.ids, 5, 6], frames: [...prompt.frames, 4, 54] },
      SYMBOLS,
      { offsetSeconds: 0, durationSeconds: 3.1 },
    );
    expect(result.words[0].start).toBeCloseTo(0);
    expect(result.words[0].end).toBeCloseTo(0.4);
    expect(result.words[1].start).toBeCloseTo(3);
    expect(result.words[1].end).toBeCloseTo(3.1);
  });

  it("returns no words when only the prompt tags are emitted", () => {
    const result = decodeSenseVoiceTokens(prompt, SYMBOLS, {
      offsetSeconds: 0,
      durationSeconds: 1,
    });
    expect(result.words).toEqual([]);
    expect(result.text).toBe("");
  });
});
