import { describe, expect, it } from "vitest";
import {
  joinAtSeam,
  mergeAdjacentSegments,
  rebuildSegmentsFromWords,
  stitchSegments,
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

/**
 * Words spoken every 0.4 s from `start`, each 0.3 s long, tagged with the
 * chunk that transcribed them.
 * @param {string} text
 * @param {number} start
 * @param {number} utteranceId
 */
function spoken(text, start, utteranceId) {
  return text.split(" ").map((word, index) => ({
    text: word,
    start: start + index * 0.4,
    end: start + index * 0.4 + 0.3,
    utteranceId,
  }));
}

/** @param {Array<{ text: string, start: number, end: number }>} words */
function rowOf(words) {
  return row(
    words.map((word) => word.text).join(" "),
    words[0].start,
    words[words.length - 1].end,
    words,
  );
}

/** @param {Array<{ words?: Array<{ utteranceId?: number }> }>} rows */
function utteranceRuns(rows) {
  const ids = rows.flatMap((r) => (r.words || []).map((w) => w.utteranceId));
  return ids.filter((id, index) => id !== ids[index - 1]);
}

const SENTENCE =
  "that means the training level of the teachers whether they are like um trained in this so that";

describe("joinAtSeam", () => {
  // Window 40 commits up to 1200 s; window 41 re-reads from 1197 s.
  const all = spoken(SENTENCE, 1192, 0);
  const earlier = [
    rowOf(
      all.filter((w) => w.end <= 1200).map((w) => ({ ...w, utteranceId: 40 })),
    ),
  ];
  const later = [
    rowOf(
      all
        .filter((w) => w.start >= 1197)
        // The second pass times words slightly differently.
        .map((w, i) => ({
          ...w,
          end: w.end + (i % 2 ? 0.03 : -0.02),
          utteranceId: 41,
        })),
    ),
  ];

  it("hands the overlap over once instead of interleaving both passes", () => {
    const joined = joinAtSeam(earlier, later, { start: 1197, end: 1200 });
    const words = joined.flatMap((r) => r.words || []);
    expect(words.map((w) => w.text).join(" ")).toBe(SENTENCE);
    expect(utteranceRuns(joined)).toEqual([40, 41]);
  });

  it("cuts in a pause between words, never through a word", () => {
    const joined = joinAtSeam(earlier, later, { start: 1197, end: 1200 });
    const words = joined.flatMap((r) => r.words || []);
    const handover = words.findIndex((w) => w.utteranceId === 41);
    expect(words[handover - 1].end).toBeLessThanOrEqual(words[handover].start);
  });

  it("rebuilds row text and bounds from the words it keeps", () => {
    const joined = joinAtSeam(earlier, later, { start: 1197, end: 1200 });
    for (const r of joined) {
      const words = r.words || [];
      expect(r.text).toBe(words.map((w) => w.text).join(" "));
      expect(r.start).toBe(words[0].start);
      expect(r.end).toBe(words[words.length - 1].end);
    }
  });

  it("keeps the only pass that heard anything in the overlap", () => {
    const before = [rowOf(spoken("earlier speech", 1190, 40))];
    const heardByLater = [
      rowOf(spoken("only the later window heard this", 1197.1, 41)),
    ];
    expect(
      joinAtSeam(before, heardByLater, { start: 1197, end: 1200 }),
    ).toEqual([...before, ...heardByLater]);
    const heardByEarlier = [
      rowOf(spoken("only the earlier window heard", 1197.1, 40)),
    ];
    const after = [rowOf(spoken("later speech", 1201, 41))];
    expect(
      joinAtSeam(heardByEarlier, after, { start: 1197, end: 1200 }),
    ).toEqual([...heardByEarlier, ...after]);
  });

  it("concatenates unchanged when there is no overlap", () => {
    const a = [rowOf(spoken("hello there", 0, 1))];
    const b = [rowOf(spoken("next one", 5, 2))];
    expect(joinAtSeam(a, b, { start: 5, end: 5 })).toEqual([...a, ...b]);
  });
});

describe("stitchSegments", () => {
  it("joins overlapping chunks at one seam", () => {
    const all = spoken(SENTENCE, 82, 0);
    const first = all
      .filter((w) => w.end <= 90)
      .map((w) => ({ ...w, utteranceId: 0 }));
    const second = all
      .filter((w) => w.start >= 87)
      .map((w, i) => ({
        ...w,
        end: w.end + (i % 2 ? 0.03 : -0.02),
        utteranceId: 1,
      }));
    const stitched = stitchSegments([
      {
        chunk: { start: 0, end: 90, regionIndex: 0 },
        segments: [rowOf(first)],
      },
      {
        chunk: { start: 87, end: 177, regionIndex: 0 },
        segments: [rowOf(second)],
      },
    ]);
    const rebuilt = rebuildSegmentsFromWords(stitched);
    const words = rebuilt.flatMap((r) => r.words || []);
    expect(words.map((w) => w.text).join(" ")).toBe(SENTENCE);
    expect(utteranceRuns(rebuilt)).toEqual([0, 1]);
  });
});
