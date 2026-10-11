import { describe, expect, it } from "vitest";
import {
  buildAlignedSegments,
  buildTimedSegments,
  isCjkDisplayWord,
  joinTranscriptText,
} from "./qwenAsrSegments.js";

describe("buildTimedSegments", () => {
  it("splits Chinese text into sentences with proportional timing", () => {
    const segments = buildTimedSegments("大家早上好。今天我们讨论预算！", {
      start: 10,
      end: 13,
      speaker: "Speaker A",
    });
    expect(segments.map((segment) => segment.text)).toEqual([
      "大家早上好。",
      "今天我们讨论预算！",
    ]);
    expect(segments[0]).toMatchObject({ start: 10, speaker: "Speaker A" });
    expect(segments[1].end).toBe(13);
    expect(segments[0].end).toBeCloseTo(segments[1].start, 5);
    expect(segments[0].end - segments[0].start).toBeLessThan(
      segments[1].end - segments[1].start,
    );
  });

  it("emits phrase-sized words so Chinese renders without inserted spaces", () => {
    const [segment] = buildTimedSegments(
      "这个budget够不够，我们办一个workshop？",
      {
        start: 0,
        end: 4,
        speaker: null,
      },
    );
    expect(segment.words.map((word) => word.text)).toEqual([
      "这个budget够不够，",
      "我们办一个workshop？",
    ]);
    expect(segment.words[0].start).toBe(0);
    expect(segment.words.at(-1).end).toBe(4);
  });

  it("keeps English words as separate timed words", () => {
    const [segment] = buildTimedSegments("Good morning everyone.", {
      start: 1,
      end: 2.5,
      speaker: null,
    });
    expect(segment.words.map((word) => word.text)).toEqual([
      "Good",
      "morning",
      "everyone.",
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(
      buildTimedSegments("  ", { start: 0, end: 1, speaker: null }),
    ).toEqual([]);
  });
});

describe("joinTranscriptText", () => {
  it("adds spaces only between Latin-script pieces", () => {
    expect(
      joinTranscriptText(["我们", "讨论", "budget", "today", "好吗"]),
    ).toBe("我们讨论budget today好吗");
  });
});

describe("buildAlignedSegments", () => {
  /** @param {number} count */
  const steps = (count) =>
    Array.from({ length: count }, (_, index) => ({
      start: 10 + index * 0.5,
      end: 10 + index * 0.5 + 0.4,
    }));

  it("times each character and word from the aligner", () => {
    const segments = buildAlignedSegments(
      "大家好。今天 budget 够吗？",
      steps(8),
      {
        speaker: "Speaker B",
      },
    );
    expect(segments.map((segment) => segment.text)).toEqual([
      "大家好。",
      "今天 budget 够吗？",
    ]);
    expect(segments[0].words.map((word) => word.text)).toEqual([
      "大",
      "家",
      "好。",
    ]);
    expect(segments[1].words.map((word) => word.text)).toEqual([
      "今",
      "天",
      "budget",
      "够",
      "吗？",
    ]);
    expect(segments[0]).toMatchObject({
      start: 10,
      end: 11.4,
      speaker: "Speaker B",
    });
    expect(segments[1].words[2]).toEqual({
      text: "budget",
      start: 12.5,
      end: 12.9,
    });
    expect(segments[1].end).toBe(13.9);
  });

  it("attaches leading punctuation to the first unit", () => {
    const [segment] = buildAlignedSegments("“好的”，走吧。", steps(4), {
      speaker: null,
    });
    expect(segment.words.map((word) => word.text)).toEqual([
      "“好",
      "的”，",
      "走",
      "吧。",
    ]);
  });

  it("ends sentences on a final full stop only", () => {
    const segments = buildAlignedSegments(
      "The U.S. team got 3.5 points. Next",
      steps(7),
      { speaker: null },
    );
    expect(segments.map((segment) => segment.text)).toEqual([
      "The U.S.",
      "team got 3.5 points.",
      "Next",
    ]);
  });

  it("rejects timings that do not match the units", () => {
    expect(() =>
      buildAlignedSegments("你好", steps(3), { speaker: null }),
    ).toThrow(/units/);
  });
});

describe("isCjkDisplayWord", () => {
  it("flags Chinese characters and their punctuation only", () => {
    expect(isCjkDisplayWord("好。")).toBe(true);
    expect(isCjkDisplayWord("“好")).toBe(true);
    expect(isCjkDisplayWord("budget")).toBe(false);
    expect(isCjkDisplayWord("这个budget")).toBe(false);
    expect(isCjkDisplayWord("3个")).toBe(false);
    expect(isCjkDisplayWord("—")).toBe(false);
  });
});
