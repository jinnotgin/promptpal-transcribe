/**
 * SenseVoice-Small input features, matching sherpa-onnx's
 * OfflineRecognizerSenseVoiceImpl: Kaldi fbank (SENSEVOICE_FBANK options),
 * then low-frame-rate stacking (7 frames every 6, so one model frame per
 * 60 ms), then CMVN with the statistics stored in the ONNX metadata.
 */

import {
  SENSEVOICE_FBANK,
  SHERPA_FBANK_BINS,
  computeSherpaFbank,
} from "./sherpaFbank.js";

/**
 * @typedef {{
 *   lfrWindowSize: number,
 *   lfrWindowShift: number,
 *   negMean: Float32Array,
 *   invStddev: Float32Array,
 *   languageIds: Record<string, number>,
 *   withItn: number,
 *   withoutItn: number,
 *   vocabSize: number,
 * }} SenseVoiceMetadata
 */

/**
 * @param {Record<string, string>} props ONNX `metadata_props` as key/value
 * @returns {SenseVoiceMetadata}
 */
export function parseSenseVoiceMetadata(props) {
  if (!props.lfr_window_size || !props.neg_mean || !props.inv_stddev) {
    throw new Error("Model is missing SenseVoice LFR/CMVN metadata");
  }
  /** @type {Record<string, number>} */
  const languageIds = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("lang_")) languageIds[key.slice(5)] = Number(value);
  }
  return {
    lfrWindowSize: Number(props.lfr_window_size),
    lfrWindowShift: Number(props.lfr_window_shift),
    negMean: parseVector(props.neg_mean),
    invStddev: parseVector(props.inv_stddev),
    languageIds,
    withItn: Number(props.with_itn),
    withoutItn: Number(props.without_itn),
    vocabSize: Number(props.vocab_size),
  };
}

/**
 * @param {string} csv
 */
function parseVector(csv) {
  return Float32Array.from(
    csv
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(Number),
  );
}

/**
 * Low-frame-rate stacking as in sherpa-onnx `ApplyLfr` / FunASR `apply_lfr`:
 * each output frame concatenates `windowSize` input frames centred on every
 * `windowShift`-th frame, repeating the first and last frames at the edges.
 * @param {Float32Array} input frame-major [frames, dim]
 * @param {number} inputFrames
 * @param {number} inputDim
 * @param {number} windowSize
 * @param {number} windowShift
 * @returns {{ data: Float32Array, frames: number, dim: number }}
 */
export function applyLfr(
  input,
  inputFrames,
  inputDim,
  windowSize,
  windowShift,
) {
  const dim = inputDim * windowSize;
  if (inputFrames <= 0) return { data: new Float32Array(0), frames: 0, dim };
  const frames = 1 + Math.floor((inputFrames - 1) / windowShift);
  const data = new Float32Array(frames * dim);
  const leftContext = Math.floor((windowSize - 1) / 2);
  let dst = 0;
  for (let i = 0; i < frames; i += 1) {
    const centre = i * windowShift;
    for (let j = 0; j < windowSize; j += 1) {
      const source = Math.min(
        inputFrames - 1,
        Math.max(0, centre - leftContext + j),
      );
      data.set(input.subarray(source * inputDim, (source + 1) * inputDim), dst);
      dst += inputDim;
    }
  }
  return { data, frames, dim };
}

/**
 * In place: `(x + negMean) * invStddev` per column.
 * @param {Float32Array} data frame-major [frames, dim]
 * @param {Float32Array} negMean
 * @param {Float32Array} invStddev
 */
export function applyCmvn(data, negMean, invStddev) {
  const dim = negMean.length;
  for (let offset = 0; offset < data.length; offset += dim) {
    for (let d = 0; d < dim; d += 1) {
      data[offset + d] = (data[offset + d] + negMean[d]) * invStddev[d];
    }
  }
}

/**
 * @param {Float32Array} pcm 16 kHz mono samples in [-1, 1]
 * @param {Pick<SenseVoiceMetadata, 'lfrWindowSize' | 'lfrWindowShift' | 'negMean' | 'invStddev'>} meta
 * @returns {{ data: Float32Array, frames: number, dim: number }}
 */
export function computeSenseVoiceFeatures(pcm, meta) {
  const fbank = computeSherpaFbank(pcm, SENSEVOICE_FBANK);
  const lfr = applyLfr(
    fbank.features,
    fbank.frames,
    SHERPA_FBANK_BINS,
    meta.lfrWindowSize,
    meta.lfrWindowShift,
  );
  applyCmvn(lfr.data, meta.negMean, meta.invStddev);
  return lfr;
}
