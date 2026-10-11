import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/nemotronFeatures.fixture.json";
import { decodeFloat32 } from "./__fixtures__/decodeFixture.js";
import {
  NEMOTRON_MEL_BINS,
  computeNemotronFeatures,
  createNemotronFeatureStream,
} from "./nemotronFeatures.js";

const pcm = decodeFloat32(fixture.pcm);
const expected = decodeFloat32(fixture.features);

/**
 * @param {Float32Array} actual
 */
function maxAbsDiff(actual) {
  let max = 0;
  for (let index = 0; index < expected.length; index += 1) {
    max = Math.max(max, Math.abs(actual[index] - expected[index]));
  }
  return max;
}

describe("computeNemotronFeatures", () => {
  it("matches the Nemotron reference log-mel features", () => {
    const features = computeNemotronFeatures(pcm);
    expect(features.length / NEMOTRON_MEL_BINS).toBe(fixture.frames);
    expect(maxAbsDiff(features)).toBeLessThan(2e-3);
  });
});

describe("createNemotronFeatureStream", () => {
  it("produces identical frames when audio arrives in uneven pieces", () => {
    const stream = createNemotronFeatureStream();
    const pieces = [];
    const sizes = [1, 159, 700, 37, 4000, 2301];
    let offset = 0;
    let sizeIndex = 0;
    while (offset < pcm.length) {
      const size = sizes[sizeIndex % sizes.length];
      pieces.push(stream.push(pcm.subarray(offset, offset + size)));
      offset += size;
      sizeIndex += 1;
    }
    pieces.push(stream.flush());
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const streamed = new Float32Array(total);
    let writeOffset = 0;
    for (const piece of pieces) {
      streamed.set(piece, writeOffset);
      writeOffset += piece.length;
    }
    expect(streamed.length / NEMOTRON_MEL_BINS).toBe(fixture.frames);
    expect(maxAbsDiff(streamed)).toBeLessThan(2e-3);
  });

  it("returns no frames for empty input", () => {
    const stream = createNemotronFeatureStream();
    expect(stream.push(new Float32Array(0))).toHaveLength(0);
    expect(stream.flush()).toHaveLength(0);
  });
});
