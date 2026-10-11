import { describe, expect, it } from "vitest";
import {
  applyCmvn,
  applyLfr,
  computeSenseVoiceFeatures,
  parseSenseVoiceMetadata,
} from "./senseVoiceFrontend.js";

/**
 * Frames whose every value is its frame index, so LFR output is easy to read.
 * @param {number} frames
 * @param {number} dim
 */
function indexFrames(frames, dim) {
  const data = new Float32Array(frames * dim);
  for (let f = 0; f < frames; f += 1) data.fill(f, f * dim, (f + 1) * dim);
  return data;
}

/**
 * @param {Float32Array} data
 * @param {number} dim
 */
function firstColumnPerBlock(data, dim) {
  return Array.from({ length: data.length / dim }, (_, i) => data[i * dim]);
}

describe("parseSenseVoiceMetadata", () => {
  it("reads LFR, CMVN and prompt ids from the sherpa-onnx export", () => {
    const meta = parseSenseVoiceMetadata({
      lfr_window_size: "7",
      lfr_window_shift: "6",
      normalize_samples: "0",
      neg_mean: "-1,-2,",
      inv_stddev: "0.5,0.25,",
      lang_auto: "0",
      lang_zh: "3",
      lang_en: "4",
      with_itn: "14",
      without_itn: "15",
      vocab_size: "25055",
    });
    expect(meta.lfrWindowSize).toBe(7);
    expect(meta.lfrWindowShift).toBe(6);
    expect(Array.from(meta.negMean)).toEqual([-1, -2]);
    expect(Array.from(meta.invStddev)).toEqual([0.5, 0.25]);
    expect(meta.languageIds).toEqual({ auto: 0, zh: 3, en: 4 });
    expect(meta.withItn).toBe(14);
    expect(meta.withoutItn).toBe(15);
  });

  it("rejects a model without SenseVoice metadata", () => {
    expect(() => parseSenseVoiceMetadata({})).toThrow(/SenseVoice/);
  });
});

describe("applyLfr", () => {
  it("stacks 7 frames every 6, padding the left with the first frame", () => {
    const { data, frames, dim } = applyLfr(indexFrames(13, 2), 13, 2, 7, 6);
    // ceil(13 / 6) output frames, each 7 input frames wide.
    expect(frames).toBe(3);
    expect(dim).toBe(14);
    const columns = firstColumnPerBlock(data, 2);
    expect(columns.slice(0, 7)).toEqual([0, 0, 0, 0, 1, 2, 3]);
    expect(columns.slice(7, 14)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    // Right edge repeats the last input frame.
    expect(columns.slice(14, 21)).toEqual([9, 10, 11, 12, 12, 12, 12]);
  });

  it("returns no frames for empty input", () => {
    expect(applyLfr(new Float32Array(0), 0, 80, 7, 6).frames).toBe(0);
  });
});

describe("applyCmvn", () => {
  it("adds the negative mean then scales by the inverse stddev per column", () => {
    const data = Float32Array.from([3, 6, 5, 10]);
    applyCmvn(
      data,
      Float32Array.from([-1, -2]),
      Float32Array.from([0.5, 0.25]),
    );
    expect(Array.from(data)).toEqual([1, 1, 2, 2]);
  });
});

describe("computeSenseVoiceFeatures", () => {
  it("produces LFR-stacked, normalised 560-dim frames", () => {
    const meta = {
      lfrWindowSize: 7,
      lfrWindowShift: 6,
      negMean: new Float32Array(560),
      invStddev: new Float32Array(560).fill(1),
    };
    // One second of audio: 98 fbank frames with snip_edges -> 17 LFR frames.
    const { data, frames, dim } = computeSenseVoiceFeatures(
      new Float32Array(16000).fill(0.01),
      meta,
    );
    expect(dim).toBe(560);
    expect(frames).toBe(17);
    expect(data.length).toBe(17 * 560);
  });
});
