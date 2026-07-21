import { describe, expect, it } from "vitest";
import {
  findAudioPartAtTime,
  normalizeTranscriptAudioManifest,
} from "./transcriptAudioManifest.js";

describe("transcriptAudioManifest", () => {
  it("normalizes an ordered format-aware absolute timeline", () => {
    const manifest = normalizeTranscriptAudioManifest({
      version: 1,
      duration: 12,
      source: "upload",
      parts: [
        {
          index: 0,
          start: 0,
          end: 5,
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          fragmentCount: 1,
        },
        {
          index: 1,
          start: 5,
          end: 12,
          mimeType: "audio/mpeg",
          sizeBytes: 120,
          fragmentCount: 1,
        },
      ],
    });

    expect(manifest.duration).toBe(12);
    expect(
      manifest.parts.every(
        (part) => !("storageKey" in part) && !("extension" in part),
      ),
    ).toBe(true);
    expect(findAudioPartAtTime(manifest, 7)).toMatchObject({
      partIndex: 1,
      relativeTime: 2,
    });
  });

  it("maps an exact boundary to the following part and clamps the final time", () => {
    const manifest = normalizeTranscriptAudioManifest({
      version: 1,
      duration: 10,
      source: "live",
      parts: [
        {
          index: 0,
          start: 0,
          end: 4,
          mimeType: "audio/webm",
          sizeBytes: 20,
          fragmentCount: 2,
        },
        {
          index: 1,
          start: 4,
          end: 10,
          mimeType: "audio/webm",
          sizeBytes: 30,
          fragmentCount: 3,
        },
      ],
    });

    expect(findAudioPartAtTime(manifest, 4)).toMatchObject({
      partIndex: 1,
      relativeTime: 0,
    });
    expect(findAudioPartAtTime(manifest, 99)).toMatchObject({
      partIndex: 1,
      relativeTime: 6,
    });
  });

  it.each([
    {
      version: 1,
      duration: 10,
      source: "upload",
      parts: [
        {
          index: 0,
          start: 0,
          end: 5,
          mimeType: "",
          sizeBytes: 1,
          fragmentCount: 1,
        },
      ],
    },
    {
      version: 1,
      duration: 10,
      source: "upload",
      parts: [
        {
          index: 0,
          start: 0,
          end: 6,
          mimeType: "audio/mpeg",
          sizeBytes: 1,
          fragmentCount: 1,
        },
        {
          index: 1,
          start: 5,
          end: 10,
          mimeType: "audio/mpeg",
          sizeBytes: 1,
          fragmentCount: 1,
        },
      ],
    },
  ])("rejects malformed or overlapping manifests", (value) => {
    expect(() => normalizeTranscriptAudioManifest(value)).toThrow();
  });
});
