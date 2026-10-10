/**
 * Chunked Nemotron 3 Diarization driver, independent of the ONNX runtime.
 *
 * Reproduces the offline loop of `Nemotron3DiarizationForAudioFrameClassification`:
 * 340-frame encoder chunks (30.4 s with 80 ms frames), each attending to 40
 * look-ahead frames and to the speaker cache. Features may arrive in any
 * number of pieces; a chunk runs as soon as its look-ahead is available, so
 * results do not depend on the pipeline's window boundaries.
 */

import {
  NEMOTRON_MEL_BINS,
  createNemotronFeatureStream,
} from "./nemotronFeatures.js";
import {
  NEMOTRON_OFFLINE_CACHE_CONFIG,
  NemotronSpeakerCache,
} from "./nemotronSpeakerCache.js";

export const NEMOTRON_CHUNK_FRAMES = 340;
export const NEMOTRON_RIGHT_CONTEXT_FRAMES = 40;
export const NEMOTRON_FRAME_SECONDS = 0.01;

/**
 * @typedef {{
 *   inputFeatures: Float32Array,
 *   melFrames: number,
 *   cachedEmbeds: Float32Array,
 *   cachedFrames: number,
 *   attentionMask: BigInt64Array,
 * }} NemotronStepInput
 * @typedef {{ logits: Float32Array, chunkEmbeds: Float32Array, silenceEmbeds: Float32Array }} NemotronStepOutput
 */

/**
 * @param {{
 *   runStep: (input: NemotronStepInput) => Promise<NemotronStepOutput>,
 *   cacheConfig?: import('./nemotronSpeakerCache.js').NemotronSpeakerCacheConfig,
 *   chunkFrames?: number,
 *   rightContextFrames?: number,
 * }} options
 */
export function createNemotronDiarizer({
  runStep,
  cacheConfig = NEMOTRON_OFFLINE_CACHE_CONFIG,
  chunkFrames = NEMOTRON_CHUNK_FRAMES,
  rightContextFrames = NEMOTRON_RIGHT_CONTEXT_FRAMES,
}) {
  const { numSpeakers, hiddenSize, subsamplingFactor } = cacheConfig;
  const cache = new NemotronSpeakerCache(cacheConfig);
  const featureStream = createNemotronFeatureStream();

  // Mel frames not yet consumed by a chunk; `melStart` is the global index of
  // the first buffered frame.
  let mel = new Float32Array(0);
  let melStart = 0;
  let melTotal = 0;
  let nextChunk = 0;
  /** @type {Float32Array[]} */
  const probChunks = [];
  let probFrames = 0;
  let finished = false;

  /** @param {Float32Array} features */
  function appendFeatures(features) {
    if (!features.length) return;
    const buffered = melTotal - melStart;
    const next = new Float32Array(
      buffered * NEMOTRON_MEL_BINS + features.length,
    );
    next.set(mel.subarray(0, buffered * NEMOTRON_MEL_BINS));
    next.set(features, buffered * NEMOTRON_MEL_BINS);
    mel = next;
    melTotal += features.length / NEMOTRON_MEL_BINS;
  }

  /** @param {boolean} final */
  async function processReady(final) {
    const encoderFrames = final
      ? Math.ceil(melTotal / subsamplingFactor)
      : Math.floor(melTotal / subsamplingFactor);
    while (nextChunk < encoderFrames) {
      const start = nextChunk;
      const end = Math.min(start + chunkFrames, encoderFrames);
      const lookaheadEnd = Math.min(end + rightContextFrames, encoderFrames);
      if (!final && lookaheadEnd < end + rightContextFrames) break;

      const melFrom = start * subsamplingFactor;
      const melTo = Math.min(lookaheadEnd * subsamplingFactor, melTotal);
      const melFrames = melTo - melFrom;
      const inputFeatures = mel.slice(
        (melFrom - melStart) * NEMOTRON_MEL_BINS,
        (melTo - melStart) * NEMOTRON_MEL_BINS,
      );
      const cachedEmbeds = cache.getEmbeds();
      const cachedFrames = cache.cachedFrameCount;
      const stepFrames = Math.ceil(melFrames / subsamplingFactor);
      const attentionMask = new BigInt64Array(cachedFrames + stepFrames).fill(
        1n,
      );

      const output = await runStep({
        inputFeatures,
        melFrames,
        cachedEmbeds,
        cachedFrames,
        attentionMask,
      });
      if (output.chunkEmbeds.length !== stepFrames * hiddenSize) {
        throw new Error(
          `Nemotron step returned ${output.chunkEmbeds.length / hiddenSize} chunk frames, expected ${stepFrames}`,
        );
      }

      const inputFrames = cachedFrames + stepFrames;
      const inputEmbeds = new Float32Array(inputFrames * hiddenSize);
      inputEmbeds.set(cachedEmbeds);
      inputEmbeds.set(output.chunkEmbeds, cachedFrames * hiddenSize);
      cache.update({
        inputEmbeds,
        inputFrames,
        logits: output.logits,
        silenceEmbeds: output.silenceEmbeds,
        chunkFrames: end - start,
        mask: null,
      });

      const logitFrom = cachedFrames * subsamplingFactor;
      const ownMelFrames = Math.min(
        (end - start) * subsamplingFactor,
        melTotal - melFrom,
      );
      const probs = new Float32Array(ownMelFrames * numSpeakers);
      for (let index = 0; index < probs.length; index += 1) {
        probs[index] = sigmoid(output.logits[logitFrom * numSpeakers + index]);
      }
      probChunks.push(probs);
      probFrames += ownMelFrames;

      nextChunk = end;
      discardMelBefore(end * subsamplingFactor);
    }
  }

  /** @param {number} globalFrame */
  function discardMelBefore(globalFrame) {
    const drop = Math.min(globalFrame, melTotal) - melStart;
    if (drop <= 0) return;
    mel = mel.slice(drop * NEMOTRON_MEL_BINS);
    melStart += drop;
  }

  return {
    /** @param {Float32Array} pcm 16 kHz mono samples */
    async pushPcm(pcm) {
      appendFeatures(featureStream.push(pcm));
      await processReady(false);
    },

    /** @param {Float32Array} features frame-major [frames, 128] */
    async pushFeatures(features) {
      appendFeatures(features);
      await processReady(false);
    },

    async finish() {
      if (finished) return;
      finished = true;
      appendFeatures(featureStream.flush());
      await processReady(true);
    },

    /** @returns {{ probs: Float32Array, frames: number, numSpeakers: number, frameSeconds: number }} */
    getProbabilities() {
      const probs = new Float32Array(probFrames * numSpeakers);
      let offset = 0;
      for (const chunk of probChunks) {
        probs.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        probs,
        frames: probFrames,
        numSpeakers,
        frameSeconds: NEMOTRON_FRAME_SECONDS,
      };
    },
  };
}

/** @param {number} value */
function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}
