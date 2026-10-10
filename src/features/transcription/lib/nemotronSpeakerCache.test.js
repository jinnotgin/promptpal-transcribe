import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/nemotronSpeakerCache.fixture.json";
import { decodeFloat32 } from "./__fixtures__/decodeFixture.js";
import { NemotronSpeakerCache } from "./nemotronSpeakerCache.js";

/**
 * @param {Float32Array} actual
 * @param {Float32Array} expected
 */
function expectClose(actual, expected) {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index], 5);
  }
}

describe("NemotronSpeakerCache", () => {
  it("reproduces the reference FIFO, cache and compression state", () => {
    const { config } = fixture;
    const cache = new NemotronSpeakerCache({
      numSpeakers: config.numSpeakers,
      hiddenSize: config.hiddenSize,
      subsamplingFactor: config.subsamplingFactor,
      speakerCacheLength: config.speakerCacheLength,
      fifoLength: config.fifoLength,
      speakerCacheUpdatePeriod: config.speakerCacheUpdatePeriod,
      silenceFramesPerSpeaker: config.silenceFramesPerSpeaker,
      predictionScoreThreshold: config.predictionScoreThreshold,
      latestFramesScoreBoost: config.latestFramesScoreBoost,
      minPositiveScoresRate: config.minPositiveScoresRate,
      strongBoostRate: config.strongBoostRate,
      weakBoostRate: config.weakBoostRate,
    });
    const silence = decodeFloat32(fixture.silence);

    for (const step of fixture.steps) {
      expect(cache.cachedFrameCount).toBe(step.cachedFrames);
      const inputEmbeds = decodeFloat32(step.inputEmbeds);
      const cached = cache.getEmbeds();
      expectClose(
        cached,
        inputEmbeds.subarray(0, step.cachedFrames * config.hiddenSize),
      );

      cache.update({
        inputEmbeds,
        inputFrames: step.inputFrames,
        logits: decodeFloat32(step.logits),
        silenceEmbeds: silence,
        chunkFrames: step.chunkFrames,
        mask: Uint8Array.from(step.mask),
      });

      expect(cache.numCacheFrames).toBe(step.expected.numCacheFrames);
      expect(cache.numFifoFrames).toBe(step.expected.numFifoFrames);
      expect(cache.isCompressed).toBe(step.expected.isCompressed);
      expectClose(cache.cacheEmbeds(), decodeFloat32(step.expected.embeds));
      expectClose(cache.cacheProbs(), decodeFloat32(step.expected.probs));
      expectClose(cache.fifoEmbeds(), decodeFloat32(step.expected.fifo));
    }
  });
});
