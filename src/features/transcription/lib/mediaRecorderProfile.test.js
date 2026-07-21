import { afterEach, describe, expect, it, vi } from "vitest";
import { selectLiveRecordingProfile } from "./mediaRecorderProfile.js";

describe("selectLiveRecordingProfile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects the first supported audio profile without user-agent guessing", () => {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: vi.fn((type) => type === "audio/webm;codecs=opus"),
    });
    expect(selectLiveRecordingProfile()).toEqual({
      mimeType: "audio/webm;codecs=opus",
    });
  });

  it("fails early when MediaRecorder is unavailable", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(() => selectLiveRecordingProfile()).toThrow(
      "compressed microphone recording",
    );
  });
});
