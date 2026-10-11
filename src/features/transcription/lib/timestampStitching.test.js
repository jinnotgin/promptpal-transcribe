import { describe, expect, it } from "vitest";
import {
  mergeAdjacentSegments,
  rebuildSegmentsFromWords,
} from "./timestampStitching.js";

/**
 * @param {string[]} texts
 * @param {number} [start]
 */
function timedWords(texts, start = 0) {
  return texts.map((text, index) => ({
    text,
    start: start + index * 0.2,
    end: start + index * 0.2 + 0.2,
  }));
}

/**
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
function row(text, start, end, words = undefined) {
  return { id: text, text, start, end, speaker: null, words };
}

describe("rebuildSegmentsFromWords", () => {
  it("joins English words with spaces and breaks after a full stop", () => {
    const rows = rebuildSegmentsFromWords([
      row("x", 0, 1, timedWords(["Hello", "there.", "Next", "one"])),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["Hello there.", "Next one"]);
  });

  it("joins Chinese characters without spaces and breaks after 。", () => {
    const rows = rebuildSegmentsFromWords([
      row("x", 0, 2, timedWords(["开", "饭", "了。", "我", "们", "用", "AI"])),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["开饭了。", "我们用AI"]);
  });

  it("keeps repeated characters from one chunk but drops overlap duplicates", () => {
    const fromChunk = (/** @type {number} */ utteranceId, words) =>
      words.map((word) => ({ ...word, utteranceId }));
    const rows = rebuildSegmentsFromWords([
      row("x", 0, 1, fromChunk(0, timedWords(["谢", "谢", "大", "家"]))),
      // The next chunk re-emits "家" at the overlap.
      row("y", 0.6, 1, fromChunk(1, timedWords(["家", "好"], 0.65))),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["谢谢大家好"]);
  });

  it("splits untimed Chinese rows into characters instead of one word", () => {
    const rows = rebuildSegmentsFromWords([row("你好世界", 0, 0.8)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("你好世界");
    expect(rows[0].words).toHaveLength(4);
  });
});

describe("mergeAdjacentSegments", () => {
  it("joins English rows with a space", () => {
    const merged = mergeAdjacentSegments([
      row("Hello", 0, 1),
      row("there", 1.2, 2),
    ]);
    expect(merged[0].text).toBe("Hello there");
  });

  it("joins Chinese rows without a space", () => {
    const merged = mergeAdjacentSegments([
      row("你好", 0, 1),
      row("世界", 1.2, 2),
    ]);
    expect(merged[0].text).toBe("你好世界");
    expect(merged[0].words).toHaveLength(4);
  });
});
