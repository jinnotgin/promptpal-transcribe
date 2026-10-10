import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/qwenAsrFeatures.fixture.json";
import { decodeFloat32 } from "./__fixtures__/decodeFixture.js";
import { computeQwenAsrFeatures } from "./qwenAsrFeatures.js";

describe("computeQwenAsrFeatures", () => {
  it("matches Whisper's 128-bin log-mel without 30 s padding", () => {
    const pcm = decodeFloat32(fixture.pcm);
    const expected = decodeFloat32(fixture.features);
    const { features, frames } = computeQwenAsrFeatures(pcm);

    expect(frames).toBe(fixture.frames);
    expect(features).toHaveLength(expected.length);
    let maxDiff = 0;
    for (let index = 0; index < expected.length; index += 1) {
      maxDiff = Math.max(maxDiff, Math.abs(features[index] - expected[index]));
    }
    expect(maxDiff).toBeLessThan(1e-3);
  });

  it("returns no frames for audio shorter than one hop", () => {
    expect(computeQwenAsrFeatures(new Float32Array(100)).frames).toBe(0);
  });
});
