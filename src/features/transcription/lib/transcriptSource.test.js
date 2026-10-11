import { describe, expect, it } from "vitest";
import {
  inferLegacyLiveRecording,
  isLiveTranscript,
} from "./transcriptSource.js";

/** @param {'upload' | 'live'} source */
const manifest = (source) => ({
  version: 1,
  duration: 4,
  source,
  parts: [
    {
      index: 0,
      start: 0,
      end: 4,
      mimeType: "audio/mpeg",
      sizeBytes: 10,
      fragmentCount: 1,
    },
  ],
});

describe("isLiveTranscript", () => {
  it("trusts a live audio manifest", () => {
    expect(isLiveTranscript({ audioManifest: manifest("live") })).toBe(true);
  });

  it("trusts the persisted live flag", () => {
    expect(isLiveTranscript({ isLiveRecording: true })).toBe(true);
  });

  it("does not treat an upload named like a live recording as live", () => {
    const record = {
      fileName: "Live Recording 2026-01-01.m4a",
      audioFileName: "Live Recording 2026-01-01.m4a",
      audioManifest: manifest("upload"),
      isLiveRecording: false,
    };
    expect(isLiveTranscript(record)).toBe(false);
  });

  it("keeps a reprocessed live recording live after its audio file is renamed", () => {
    const record = {
      fileName: "Team sync",
      audioFileName: "Team sync",
      audioManifest: manifest("live"),
    };
    expect(isLiveTranscript(record)).toBe(true);
  });

  it("treats a record without any source signal as an upload", () => {
    expect(isLiveTranscript({})).toBe(false);
    expect(isLiveTranscript(null)).toBe(false);
  });
});

describe("inferLegacyLiveRecording", () => {
  it("lets the audio manifest decide when one exists", () => {
    expect(
      inferLegacyLiveRecording(
        { fileName: "Live Recording 1/1/2026", isLiveRecording: false },
        { audioManifest: manifest("upload") },
      ),
    ).toBe(false);
    expect(
      inferLegacyLiveRecording(
        { fileName: "Interview", isLiveRecording: false },
        { audioManifest: manifest("live") },
      ),
    ).toBe(true);
  });

  it("keeps an existing live flag", () => {
    expect(
      inferLegacyLiveRecording({ fileName: "x", isLiveRecording: true }, null),
    ).toBe(true);
  });

  it("falls back to the old live naming only for records without audio", () => {
    expect(
      inferLegacyLiveRecording({ fileName: "Live Recording 1/1/2026" }, {}),
    ).toBe(true);
    expect(
      inferLegacyLiveRecording(
        { fileName: "Old" },
        { audioFileName: "live-recording" },
      ),
    ).toBe(true);
    expect(inferLegacyLiveRecording({ fileName: "Interview.mp3" }, {})).toBe(
      false,
    );
  });
});
