/**
 * Whisper-compatible log-mel features for Qwen3-ASR.
 *
 * 16 kHz, n_fft 400 with a periodic Hann window, centred STFT with reflect
 * padding, power spectrum, 128-bin Slaney filterbank, log10 with a 1e-10
 * floor, clamp to (max - 8), (x + 4) / 4, last frame dropped. No 30 s
 * padding: the encoder accepts any length.
 */

import { createFft } from "./fft.js";
import { createSlaneyMelFilters } from "./nemotronFeatures.js";

export const QWEN_ASR_SAMPLE_RATE = 16000;
export const QWEN_ASR_MEL_BINS = 128;
const N_FFT = 400;
const HOP_LENGTH = 160;
const PADDING = N_FFT / 2;

/** @type {import('./nemotronFeatures.js').MelFilter[] | null} */
let sharedFilters = null;
/** @type {Float64Array | null} */
let sharedWindow = null;

/**
 * @param {Float32Array} pcm 16 kHz mono samples
 * @returns {{ features: Float32Array, frames: number }} mel-major [128, frames]
 */
export function computeQwenAsrFeatures(pcm) {
  const frames = Math.floor(pcm.length / HOP_LENGTH);
  if (frames <= 0 || pcm.length <= PADDING) {
    return { features: new Float32Array(0), frames: 0 };
  }
  const filters = getFilters();
  const window = getWindow();
  const fft = createFft(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const logMel = new Float64Array(QWEN_ASR_MEL_BINS * frames);
  let max = -Infinity;

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * HOP_LENGTH - PADDING;
    for (let k = 0; k < N_FFT; k += 1) {
      re[k] = pcm[reflectIndex(start + k, pcm.length)] * window[k];
      im[k] = 0;
    }
    fft.transform(re, im);
    for (let mel = 0; mel < QWEN_ASR_MEL_BINS; mel += 1) {
      const { start: firstBin, weights } = filters[mel];
      let energy = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const bin = firstBin + k;
        energy += weights[k] * (re[bin] * re[bin] + im[bin] * im[bin]);
      }
      const value = Math.log10(Math.max(energy, 1e-10));
      logMel[mel * frames + frame] = value;
      if (value > max) max = value;
    }
  }

  const floor = max - 8;
  const features = new Float32Array(logMel.length);
  for (let index = 0; index < logMel.length; index += 1) {
    features[index] = (Math.max(logMel[index], floor) + 4) / 4;
  }
  return { features, frames };
}

/**
 * numpy "reflect" padding (edge sample not repeated).
 * @param {number} index
 * @param {number} length
 */
function reflectIndex(index, length) {
  if (index < 0) return -index;
  if (index >= length) return 2 * (length - 1) - index;
  return index;
}

function getFilters() {
  if (!sharedFilters) {
    sharedFilters = createSlaneyMelFilters({
      sampleRate: QWEN_ASR_SAMPLE_RATE,
      nFft: N_FFT,
      melBins: QWEN_ASR_MEL_BINS,
      fmin: 0,
      fmax: QWEN_ASR_SAMPLE_RATE / 2,
    });
  }
  return sharedFilters;
}

function getWindow() {
  if (!sharedWindow) {
    sharedWindow = new Float64Array(N_FFT);
    for (let k = 0; k < N_FFT; k += 1) {
      sharedWindow[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N_FFT);
    }
  }
  return sharedWindow;
}
