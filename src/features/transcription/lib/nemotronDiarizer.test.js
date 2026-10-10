import { describe, expect, it } from "vitest";
import { createNemotronDiarizer } from "./nemotronDiarizer.js";

const MEL_BINS = 128;
const cacheConfig = {
  numSpeakers: 2,
  hiddenSize: 2,
  subsamplingFactor: 8,
  speakerCacheLength: 8,
  fifoLength: 2,
  speakerCacheUpdatePeriod: 3,
  silenceFramesPerSpeaker: 1,
  predictionScoreThreshold: 0.25,
  latestFramesScoreBoost: 0.05,
  minPositiveScoresRate: 0.5,
  strongBoostRate: 0.75,
  weakBoostRate: 1.5,
};

/**
 * Fake model step: speaker 0 is active on every mel frame whose first feature
 * is positive. Logits cover the cached frames too, as the real graph does.
 */
function createFakeStep() {
  /** @type {Array<{ melFrames: number, cachedFrames: number, maskLength: number }>} */
  const calls = [];
  /** @param {{ inputFeatures: Float32Array, melFrames: number, cachedEmbeds: Float32Array, cachedFrames: number, attentionMask: BigInt64Array }} input */
  async function runStep(input) {
    calls.push({
      melFrames: input.melFrames,
      cachedFrames: input.cachedFrames,
      maskLength: input.attentionMask.length,
    });
    const chunkFrames = Math.ceil(input.melFrames / 8);
    const totalFrames = input.cachedFrames + chunkFrames;
    const logits = new Float32Array(totalFrames * 8 * 2).fill(-8);
    for (let mel = 0; mel < input.melFrames; mel += 1) {
      const row = (input.cachedFrames * 8 + mel) * 2;
      logits[row] = input.inputFeatures[mel * MEL_BINS] > 0 ? 8 : -8;
    }
    return {
      logits,
      chunkEmbeds: new Float32Array(chunkFrames * 2).fill(0.5),
      silenceEmbeds: new Float32Array(2),
    };
  }
  return { calls, runStep };
}

/** @param {number} frames */
function makeFeatures(frames) {
  const features = new Float32Array(frames * MEL_BINS);
  for (let frame = 0; frame < frames; frame += 1) {
    features[frame * MEL_BINS] = frame % 50 < 25 ? 1 : -1;
  }
  return features;
}

describe("createNemotronDiarizer", () => {
  it("runs chunks with look-ahead and returns one probability row per mel frame", async () => {
    const fake = createFakeStep();
    const diarizer = createNemotronDiarizer({
      runStep: fake.runStep,
      cacheConfig,
      chunkFrames: 4,
      rightContextFrames: 2,
    });
    const features = makeFeatures(101);
    await diarizer.pushFeatures(features);
    await diarizer.finish();

    const result = diarizer.getProbabilities();
    expect(result.frames).toBe(101);
    expect(result.numSpeakers).toBe(2);
    for (let frame = 0; frame < 101; frame += 1) {
      const expected = frame % 50 < 25 ? 1 : 0;
      expect(Math.round(result.probs[frame * 2])).toBe(expected);
    }
    // 101 mel frames = 13 encoder frames: chunks start at 0, 4, 8, 12.
    expect(fake.calls.map((call) => call.melFrames)).toEqual([48, 48, 37, 5]);
    expect(fake.calls[0].cachedFrames).toBe(0);
    for (const call of fake.calls) {
      expect(call.maskLength).toBe(
        call.cachedFrames + Math.ceil(call.melFrames / 8),
      );
    }
  });

  it("is independent of how features are split across pushes", async () => {
    const features = makeFeatures(203);
    const whole = createFakeStep();
    const wholeDiarizer = createNemotronDiarizer({
      runStep: whole.runStep,
      cacheConfig,
      chunkFrames: 4,
      rightContextFrames: 2,
    });
    await wholeDiarizer.pushFeatures(features);
    await wholeDiarizer.finish();

    const pieces = createFakeStep();
    const pieceDiarizer = createNemotronDiarizer({
      runStep: pieces.runStep,
      cacheConfig,
      chunkFrames: 4,
      rightContextFrames: 2,
    });
    for (const [start, end] of [
      [0, 7],
      [7, 60],
      [60, 61],
      [61, 203],
    ]) {
      await pieceDiarizer.pushFeatures(
        features.subarray(start * MEL_BINS, end * MEL_BINS),
      );
    }
    await pieceDiarizer.finish();

    expect(pieces.calls).toEqual(whole.calls);
    expect(pieceDiarizer.getProbabilities().probs).toEqual(
      wholeDiarizer.getProbabilities().probs,
    );
  });

  it("returns no rows when no audio was pushed", async () => {
    const fake = createFakeStep();
    const diarizer = createNemotronDiarizer({
      runStep: fake.runStep,
      cacheConfig,
    });
    await diarizer.finish();
    expect(diarizer.getProbabilities().frames).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});
