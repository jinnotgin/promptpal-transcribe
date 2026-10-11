import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/sherpaFbank.fixture.json";
import { decodeFloat32 } from "./__fixtures__/decodeFixture.js";
import { SHERPA_FBANK_BINS, computeSherpaFbank } from "./sherpaFbank.js";

const pcm = decodeFloat32(fixture.pcm);
const expected = decodeFloat32(fixture.features);

describe("computeSherpaFbank", () => {
  it("matches kaldi-native-fbank with sherpa-onnx's embedding options", () => {
    const { features, frames } = computeSherpaFbank(pcm);
    expect(frames).toBe(fixture.frames);
    expect(features.length).toBe(frames * SHERPA_FBANK_BINS);
    let max = 0;
    for (let index = 0; index < expected.length; index += 1) {
      max = Math.max(max, Math.abs(features[index] - expected[index]));
    }
    expect(max).toBeLessThan(2e-3);
  });

  it("returns no frames for audio shorter than half a frame shift", () => {
    expect(computeSherpaFbank(new Float32Array(40)).frames).toBe(0);
  });
});
