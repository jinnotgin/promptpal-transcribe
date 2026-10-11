import { describe, expect, it, vi } from "vitest";
import {
  constructTranscriptSegments,
  flattenSegmentWords,
  normalizeConstructedSegments,
} from "./transcriptPostProcessing.js";

const mocks = vi.hoisted(() => ({
  constructSentences: vi.fn(),
}));

vi.mock("./transcriptProcessingCore.js", () => ({
  initTranscriptProcessingCore: vi.fn(),
  prepareWords: vi.fn((words) => words),
  constructSentences: mocks.constructSentences,
}));

const sourceSegments = [
  {
    id: "source-1",
    text: "Hello there.",
    start: 0,
    end: 1,
    speaker: null,
    words: [{ text: "Hello", start: 0, end: 0.5 }],
  },
];

describe("constructTranscriptSegments", () => {
  it("removes the sentence builder's placeholder speaker when diarization is skipped", async () => {
    mocks.constructSentences.mockReturnValue([
      {
        id: "constructed-1",
        text: "Hello there.",
        start: 0,
        end: 1,
        speaker: "Speaker A",
      },
    ]);

    const segments = await constructTranscriptSegments(sourceSegments, {
      skipDiarize: true,
    });

    expect(segments).toEqual([
      expect.objectContaining({
        id: "constructed-1",
        text: "Hello there.",
        speaker: null,
      }),
    ]);
  });

  it("preserves constructed speaker labels when diarization is enabled", async () => {
    mocks.constructSentences.mockReturnValue([
      {
        id: "constructed-1",
        text: "Hello there.",
        start: 0,
        end: 1,
        speaker: "Speaker A",
      },
    ]);

    const segments = await constructTranscriptSegments(sourceSegments, {
      skipDiarize: false,
    });

    expect(segments[0].speaker).toBe("Speaker A");
  });
});

/**
 * @param {string[]} texts
 */
function timed(texts) {
  return texts.map((text, index) => ({
    text,
    start: index * 0.2,
    end: index * 0.2 + 0.2,
  }));
}

describe("normalizeConstructedSegments", () => {
  it("re-joins Chinese text the sentence builder spaced out", () => {
    const [segment] = normalizeConstructedSegments([
      {
        id: "c1",
        text: "我 们 用 machine learning",
        start: 0,
        end: 1,
        speaker: "Speaker A",
        words: timed(["我", "们", "用", "machine", "learning"]),
      },
    ]);
    expect(segment.text).toBe("我们用machine learning");
  });

  it("splits Chinese sentences the builder ran together", () => {
    const segments = normalizeConstructedSegments([
      {
        id: "c1",
        text: "开 饭 了。 好 吗？",
        start: 0,
        end: 1,
        speaker: "Speaker B",
        words: timed(["开", "饭", "了。", "好", "吗？"]),
      },
    ]);
    expect(segments.map((segment) => segment.text)).toEqual([
      "开饭了。",
      "好吗？",
    ]);
    expect(segments[1]).toMatchObject({
      start: 0.6,
      end: 1,
      speaker: "Speaker B",
    });
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(2);
  });

  it("leaves English text from the builder untouched", () => {
    const [segment] = normalizeConstructedSegments([
      {
        id: "c1",
        text: "Hello there. Bye.",
        start: 0,
        end: 1,
        words: timed(["Hello", "there.", "Bye."]),
      },
    ]);
    expect(segment.text).toBe("Hello there. Bye.");
  });
});

describe("flattenSegmentWords", () => {
  it("splits untimed Chinese rows into characters", () => {
    const words = flattenSegmentWords([
      { id: "r", text: "你好。", start: 0, end: 0.4, speaker: null },
    ]);
    expect(words.map((word) => word.text)).toEqual(["你", "好。"]);
  });
});
