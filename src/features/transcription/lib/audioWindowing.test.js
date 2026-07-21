import { describe, expect, it } from "vitest";
import {
  AUDIO_WINDOW_OVERLAP_SECONDS,
  AUDIO_WINDOW_SECONDS,
  createAudioWindows,
  getCommittedPcmView,
} from "./audioWindowing.js";

describe("createAudioWindows", () => {
  it("uses the bounded window contract even for a short file", () => {
    expect(createAudioWindows(42)).toEqual([
      {
        index: 0,
        total: 1,
        readStart: 0,
        readEnd: 42,
        commitStart: 0,
        commitEnd: 42,
        isFinal: true,
      },
    ]);
  });

  it("adds bounded leading context without changing committed coverage", () => {
    const duration = AUDIO_WINDOW_SECONDS * 2 + 17;
    const windows = createAudioWindows(duration);

    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({
      readStart: 0,
      readEnd: AUDIO_WINDOW_SECONDS,
      commitStart: 0,
      commitEnd: AUDIO_WINDOW_SECONDS,
    });
    expect(windows[1]).toMatchObject({
      readStart: AUDIO_WINDOW_SECONDS - AUDIO_WINDOW_OVERLAP_SECONDS,
      readEnd: AUDIO_WINDOW_SECONDS * 2,
      commitStart: AUDIO_WINDOW_SECONDS,
      commitEnd: AUDIO_WINDOW_SECONDS * 2,
    });
    expect(windows[2]).toMatchObject({
      readStart: AUDIO_WINDOW_SECONDS * 2 - AUDIO_WINDOW_OVERLAP_SECONDS,
      readEnd: duration,
      commitStart: AUDIO_WINDOW_SECONDS * 2,
      commitEnd: duration,
      isFinal: true,
    });
  });

  it("rejects invalid durations instead of creating an unbounded request", () => {
    expect(() => createAudioWindows(0)).toThrow(/duration/i);
    expect(() => createAudioWindows(Number.POSITIVE_INFINITY)).toThrow(
      /duration/i,
    );
  });

  it("selects only committed PCM and excludes the leading ASR overlap", () => {
    const pcm = new Float32Array([-3, -3, 1, 2, 3, 4]);

    const committed = getCommittedPcmView(
      pcm,
      { readStart: 1, readEnd: 4, commitStart: 2, commitEnd: 4 },
      { sampleRate: 2 },
    );

    expect([...committed]).toEqual([1, 2, 3, 4]);
    expect(committed.buffer).toBe(pcm.buffer);
  });
});
