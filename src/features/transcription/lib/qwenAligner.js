/**
 * Qwen3-ForcedAligner: real character/word timings for Qwen3-ASR text.
 *
 * One non-autoregressive forward pass per clip (at most 5 minutes; regions
 * here are 30 s or less): the prompt holds the clip's audio tokens and the
 * transcript units, each followed by two `<timestamp>` slots whose argmax
 * class (80 ms steps) gives the unit's start and end.
 */

import { computeQwenAsrFeatures } from "./qwenAsrFeatures.js";
import { qwenAudioTokenCount } from "./qwenAsrPrompt.js";
import {
  buildAlignerPrompt,
  createQwenBpeEncoder,
  splitAlignerUnits,
} from "./qwenAlignerText.js";
import { alignedUnitTimes } from "./qwenAlignerTimestamps.js";

const SAMPLE_RATE = 16000;
export const ALIGNER_MAX_SECONDS = 300;

/**
 * @typedef {(input: {
 *   inputIds: BigInt64Array,
 *   features: Float32Array,
 *   frames: number,
 * }) => Promise<{ logits: Float32Array, classes: number }>} RunAligner
 *   features are mel-major [128, frames]; logits are [ids, classes]
 */

/**
 * @param {{
 *   runModel: RunAligner,
 *   vocab: Record<string, number>,
 *   merges: Iterable<[number, string]>,
 * }} options
 */
export function createQwenAligner({ runModel, vocab, merges }) {
  const encoder = createQwenBpeEncoder({ vocab, merges });

  return {
    /**
     * @param {Float32Array} pcm 16 kHz mono clip
     * @param {string} text transcript of the clip
     * @param {{ offset?: number }} [options] clip start in seconds
     * @returns {Promise<Array<{ start: number, end: number }> | null>} one
     *   timing per aligner unit, or null when there is nothing to align
     */
    async align(pcm, text, options = {}) {
      const units = splitAlignerUnits(text);
      if (!units.length) return null;
      if (pcm.length > ALIGNER_MAX_SECONDS * SAMPLE_RATE) {
        throw new Error("Aligner clips must be 5 minutes or shorter");
      }
      const { features, frames } = computeQwenAsrFeatures(pcm);
      if (!frames) return null;
      const { ids, timestampPositions } = buildAlignerPrompt({
        audioTokens: qwenAudioTokenCount(frames),
        units: units.map((unit) => encoder.encode(unit.text)),
      });
      const { logits, classes } = await runModel({
        inputIds: BigInt64Array.from(ids, (id) => BigInt(id)),
        features,
        frames,
      });
      const predicted = timestampPositions.map((position) =>
        argmax(logits, position * classes, classes),
      );
      const clipEnd = (options.offset ?? 0) + pcm.length / SAMPLE_RATE;
      return alignedUnitTimes(predicted, units.length, options).map((time) => ({
        start: Math.min(time.start, clipEnd),
        end: Math.min(time.end, clipEnd),
      }));
    },
  };
}

/**
 * @param {Float32Array} values
 * @param {number} offset
 * @param {number} length
 */
function argmax(values, offset, length) {
  let best = 0;
  for (let index = 1; index < length; index += 1) {
    if (values[offset + index] > values[offset + best]) best = index;
  }
  return best;
}
