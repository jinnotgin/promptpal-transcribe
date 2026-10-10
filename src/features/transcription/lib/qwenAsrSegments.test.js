import { describe, expect, it } from "vitest";
import { buildTimedSegments, joinTranscriptText } from "./qwenAsrSegments.js";

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
