import { describe, expect, it } from "vitest";
import {
  buildPayload,
  buildSummary,
  countSpeakers,
  derivePreview,
  generateRecordId,
  serializeSegments,
} from "./transcriptHistoryRecords.js";

const segment = (overrides = {}) => ({
  id: "seg-1",
  start: 0,
  end: 1,
  text: "hello world",
  speaker: "Speaker 1",
  ...overrides,
});

describe("transcriptHistoryRecords", () => {
  describe("generateRecordId", () => {
    it("returns unique non-empty ids", () => {
      const a = generateRecordId();
      const b = generateRecordId();
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a).not.toBe(b);
    });
  });

  describe("serializeSegments", () => {
    it("coerces fields and drops unknown keys, keeping words when present", () => {
      const result = serializeSegments(
        /** @type {any} */ ([
          {
            id: 7,
            start: "1.5",
            end: "2.5",
            text: "hi",
            speaker: "Speaker 2",
            extra: "nope",
            words: [
              { text: "hi", start: 1.5, end: 2.5, confidence: 0.9, junk: 1 },
            ],
          },
        ]),
      );
      expect(result).toEqual([
        {
          id: "7",
          start: 1.5,
          end: 2.5,
          text: "hi",
          speaker: "Speaker 2",
          words: [{ text: "hi", start: 1.5, end: 2.5, confidence: 0.9 }],
        },
      ]);
    });

    it("returns an empty array for non-array input", () => {
      expect(serializeSegments(undefined)).toEqual([]);
    });
  });

  describe("countSpeakers", () => {
    it("counts distinct segment speakers plus added speaker ids", () => {
      const segments = [
        segment({ id: "a", speaker: "Speaker 1" }),
        segment({ id: "b", speaker: "Speaker 2" }),
        segment({ id: "c", speaker: "Speaker 1" }),
        segment({ id: "d", speaker: null }),
      ];
      expect(countSpeakers(segments, ["Speaker 3", "Speaker 1"])).toBe(3);
    });
  });

  describe("derivePreview", () => {
    it("joins leading segment text and truncates long previews", () => {
      const long = "word ".repeat(80).trim();
      const preview = derivePreview([segment({ text: long })]);
      expect(preview.length).toBeLessThanOrEqual(161);
      expect(preview.endsWith("…")).toBe(true);
    });

    it("skips empty segments", () => {
      expect(
        derivePreview([segment({ text: "  " }), segment({ text: "real" })]),
      ).toBe("real");
    });
  });

  describe("buildSummary", () => {
    it("derives counts and preview and normalizes duration", () => {
      const summary = buildSummary({
        id: "rec-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        fileName: "memo.mp3",
        fileSize: 1234,
        fileDuration: 12.5,
        isLiveRecording: true,
        segments: [
          segment({ speaker: "Speaker 1" }),
          segment({ id: "s2", speaker: "Speaker 2" }),
        ],
        addedSpeakerIds: ["Speaker 3"],
      });
      expect(summary).toMatchObject({
        id: "rec-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        fileName: "memo.mp3",
        fileSize: 1234,
        fileDuration: 12.5,
        isLiveRecording: true,
        speakerCount: 3,
        segmentCount: 2,
      });
      expect(summary.preview).toBe("hello world hello world");
      expect(summary.updatedAt).toBeTruthy();
    });

    it("falls back to null duration when not finite", () => {
      expect(
        buildSummary({ id: "x", fileDuration: NaN, segments: [segment()] })
          .fileDuration,
      ).toBe(null);
    });
  });

  describe("buildPayload", () => {
    it("serializes segments and clones speaker maps", () => {
      const speakerNames = { "Speaker 1": "Alice" };
      const payload = buildPayload({
        id: "rec-1",
        fileName: "memo.mp3",
        segments: [segment()],
        speakerNames,
      });
      expect(payload.id).toBe("rec-1");
      expect(payload.audioFileName).toBe("memo.mp3");
      expect(payload.segments[0].id).toBe("seg-1");
      expect(payload.speakerNames).toEqual(speakerNames);
      expect(payload.speakerNames).not.toBe(speakerNames);
    });
  });
});
