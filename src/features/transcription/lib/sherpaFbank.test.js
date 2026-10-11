import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/sherpaFbank.fixture.json";
import senseVoiceFixture from "./__fixtures__/senseVoiceFbank.fixture.json";
import { decodeFloat32 } from "./__fixtures__/decodeFixture.js";
import {
  SENSEVOICE_FBANK,
  SHERPA_FBANK_BINS,
  computeSherpaFbank,
} from "./sherpaFbank.js";

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

describe("computeSherpaFbank with SenseVoice options", () => {
  it("matches kaldi-native-fbank with sherpa-onnx's SenseVoice options", () => {
    const { features, frames } = computeSherpaFbank(
      decodeFloat32(senseVoiceFixture.pcm),
      SENSEVOICE_FBANK,
    );
    const reference = decodeFloat32(senseVoiceFixture.features);
    expect(frames).toBe(senseVoiceFixture.frames);
    expect(features.length).toBe(reference.length);
    let max = 0;
    for (let index = 0; index < reference.length; index += 1) {
      max = Math.max(max, Math.abs(features[index] - reference[index]));
    }
    expect(max).toBeLessThan(2e-3);
  });

  it("returns no frames for audio shorter than one window when snipping edges", () => {
    expect(
      computeSherpaFbank(new Float32Array(399), SENSEVOICE_FBANK).frames,
    ).toBe(0);
    expect(
      computeSherpaFbank(new Float32Array(400), SENSEVOICE_FBANK).frames,
    ).toBe(1);
  });
});
