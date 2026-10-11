/**
 * Kaldi log-mel filterbank used by sherpa-onnx's speaker-embedding extractor
 * (kaldi-native-fbank v1.22.3 with sherpa-onnx's `FeatureExtractorConfig`).
 *
 * 16 kHz, 25 ms Povey window every 10 ms, `snip_edges = false` (frames
 * centred on each shift, edges reflected), DC removal, 0.97 pre-emphasis,
 * zero-padded 512-point FFT power spectrum, 80 HTK-mel triangles from 20 Hz to
 * 7600 Hz, natural log floored at float epsilon. No dither.
 */

import { createFft } from "./fft.js";

export const SHERPA_FBANK_BINS = 80;
const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const PADDED_LENGTH = 512;
const PREEMPHASIS = 0.97;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2 - 400;
const FLOAT_EPSILON = 1.1920928955078125e-7;

/** @type {{ window: Float64Array, banks: Array<{ first: number, weights: Float64Array }> } | null} */
let shared = null;

/**
 * @param {Float32Array} pcm 16 kHz mono samples in [-1, 1]
 * @returns {{ features: Float32Array, frames: number }} frame-major [frames, 80]
 */
export function computeSherpaFbank(pcm) {
  const frames = Math.floor((pcm.length + FRAME_SHIFT / 2) / FRAME_SHIFT);
  const features = new Float32Array(frames * SHERPA_FBANK_BINS);
  if (frames === 0) return { features, frames };
  const { window, banks } = getTables();
  const fft = createFft(PADDED_LENGTH);
  const re = new Float64Array(PADDED_LENGTH);
  const im = new Float64Array(PADDED_LENGTH);
  const frame = new Float64Array(FRAME_LENGTH);
  const power = new Float64Array(PADDED_LENGTH / 2 + 1);

  for (let f = 0; f < frames; f += 1) {
    const first = f * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LENGTH / 2;
    let mean = 0;
    for (let s = 0; s < FRAME_LENGTH; s += 1) {
      frame[s] = pcm[reflect(first + s, pcm.length)];
      mean += frame[s];
    }
    mean /= FRAME_LENGTH;
    for (let s = 0; s < FRAME_LENGTH; s += 1) frame[s] -= mean;
    for (let s = FRAME_LENGTH - 1; s > 0; s -= 1) {
      frame[s] -= PREEMPHASIS * frame[s - 1];
    }
    frame[0] -= PREEMPHASIS * frame[0];

    for (let s = 0; s < PADDED_LENGTH; s += 1) {
      re[s] = s < FRAME_LENGTH ? frame[s] * window[s] : 0;
      im[s] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= PADDED_LENGTH / 2; k += 1) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }

    const out = f * SHERPA_FBANK_BINS;
    for (let bin = 0; bin < SHERPA_FBANK_BINS; bin += 1) {
      const { first: offset, weights } = banks[bin];
      let energy = 0;
      for (let k = 0; k < weights.length; k += 1) {
        energy += weights[k] * power[offset + k];
      }
      features[out + bin] = Math.log(Math.max(energy, FLOAT_EPSILON));
    }
  }
  return { features, frames };
}

/**
 * Kaldi's edge reflection: -1 -> 0, -2 -> 1, n -> n - 1.
 * @param {number} index
 * @param {number} length
 */
function reflect(index, length) {
  let i = index;
  while (i < 0 || i >= length) {
    i = i < 0 ? -i - 1 : 2 * length - 1 - i;
  }
  return i;
}

function getTables() {
  if (shared) return shared;
  const window = new Float64Array(FRAME_LENGTH);
  for (let s = 0; s < FRAME_LENGTH; s += 1) {
    window[s] =
      (0.5 - 0.5 * Math.cos((2 * Math.PI * s) / (FRAME_LENGTH - 1))) ** 0.85;
  }
  const melScale = (/** @type {number} */ freq) =>
    1127 * Math.log(1 + freq / 700);
  const fftBins = PADDED_LENGTH / 2;
  const binWidth = SAMPLE_RATE / PADDED_LENGTH;
  const melLow = melScale(LOW_FREQ);
  const melDelta = (melScale(HIGH_FREQ) - melLow) / (SHERPA_FBANK_BINS + 1);
  const banks = [];
  for (let bin = 0; bin < SHERPA_FBANK_BINS; bin += 1) {
    const left = melLow + bin * melDelta;
    const centre = left + melDelta;
    const right = centre + melDelta;
    let first = -1;
    /** @type {number[]} */
    const weights = [];
    for (let k = 0; k < fftBins; k += 1) {
      const mel = melScale(binWidth * k);
      if (mel > left && mel < right) {
        if (first < 0) first = k;
        weights[k - first] =
          mel <= centre
            ? (mel - left) / (centre - left)
            : (right - mel) / (right - centre);
      }
    }
    banks.push({ first, weights: Float64Array.from(weights, (w) => w ?? 0) });
  }
  shared = { window, banks };
  return shared;
}
