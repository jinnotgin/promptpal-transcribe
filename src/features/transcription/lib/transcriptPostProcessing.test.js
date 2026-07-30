import { describe, expect, it, vi } from "vitest";
import { constructTranscriptSegments } from "./transcriptPostProcessing.js";

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
