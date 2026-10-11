import { describe, expect, it } from "vitest";
import { wordsToSegments } from "./asrWordSegments.js";

/**
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
const word = (text, start, end) => ({ text, start, end });

describe("wordsToSegments", () => {
  it("groups words into segments and splits on long pauses", () => {
    const segments = wordsToSegments(
      [word("Hello", 0, 0.4), word("world.", 0.5, 0.9), word("Next", 2.2, 2.5)],
      "",
      0,
      3,
    );
    expect(segments.map((segment) => segment.text)).toEqual([
      "Hello world.",
      "Next",
    ]);
    expect(segments[0]).toMatchObject({ start: 0, end: 0.9 });
  });

  it("joins Chinese characters without spaces", () => {
    const segments = wordsToSegments(
      [word("开", 0.6, 0.84), word("饭", 0.84, 1.2), word("了。", 1.2, 1.5)],
      "",
      0,
      2,
    );
    expect(segments.map((segment) => segment.text)).toEqual(["开饭了。"]);
  });

  it("starts a new segment after 16 words", () => {
    const words = Array.from({ length: 17 }, (_, i) =>
      word(`w${i}`, i * 0.2, i * 0.2 + 0.1),
    );
    expect(wordsToSegments(words, "", 0, 4)).toHaveLength(2);
  });

  it("falls back to the chunk text when no words are timed", () => {
    expect(wordsToSegments([], "  some   text ", 5, 2)).toEqual([
      { text: "some text", start: 5, end: 7, words: [] },
    ]);
  });
});
