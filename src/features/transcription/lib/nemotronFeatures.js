/**
 * Streaming log-mel features for Nemotron 3 Diarization.
 *
 * Mirrors `NemotronAsrStreamingFeatureExtractor` (transformers): 0.97
 * preemphasis, symmetric 400-sample Hann window centred in a 512-point FFT,
 * centred STFT with zero padding, power spectrum, 128-bin Slaney mel
 * filterbank, natural log with a 2^-24 guard and no normalisation. Audio can
 * be pushed in arbitrary pieces; frames match a single pass over the whole
 * recording.
 */

import { createFft } from "./fft.js";

export const NEMOTRON_SAMPLE_RATE = 16000;
export const NEMOTRON_MEL_BINS = 128;
export const NEMOTRON_HOP_LENGTH = 160;

const N_FFT = 512;
const WIN_LENGTH = 400;
const WINDOW_OFFSET = (N_FFT - WIN_LENGTH) / 2;
const CENTER_PADDING = N_FFT / 2;
const PREEMPHASIS = 0.97;
const LOG_GUARD = 2 ** -24;

/**
 * @typedef {{ start: number, weights: Float64Array }} MelFilter
 */

/** @type {MelFilter[] | null} */
let sharedFilters = null;
/** @type {Float64Array | null} */
let sharedWindow = null;

/**
 * Compute features for a complete recording.
 * @param {Float32Array} pcm 16 kHz mono samples
 * @returns {Float32Array} frame-major [frames, 128]
 */
export function computeNemotronFeatures(pcm) {
  const stream = createNemotronFeatureStream();
  const head = stream.push(pcm);
  const tail = stream.flush();
  const features = new Float32Array(head.length + tail.length);
  features.set(head);
  features.set(tail, head.length);
  return features;
}

/**
 * Incremental extractor. `push` returns every frame whose window is complete;
 * `flush` pads the end and returns the remaining valid frames.
 */
export function createNemotronFeatureStream() {
  const fft = createFft(N_FFT);
  const filters = getMelFilters();
  const window = getWindow();
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float64Array(N_FFT / 2 + 1);

  // Pre-emphasised samples in padded coordinates: padded index = sample + 256.
  let buffer = new Float32Array(CENTER_PADDING);
  let bufferStart = 0;
  let bufferLength = CENTER_PADDING;
  let totalSamples = 0;
  let previousSample = 0;
  let nextFrame = 0;
  let flushed = false;

  /** @param {number} extra */
  function reserve(extra) {
    if (bufferLength + extra <= buffer.length) return;
    const next = new Float32Array(
      Math.max(buffer.length * 2, bufferLength + extra),
    );
    next.set(buffer.subarray(0, bufferLength));
    buffer = next;
  }

  /** @param {Float32Array} samples */
  function append(samples) {
    reserve(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      buffer[bufferLength + index] =
        totalSamples + index === 0
          ? sample
          : sample - PREEMPHASIS * previousSample;
      previousSample = sample;
    }
    bufferLength += samples.length;
    totalSamples += samples.length;
  }

  /** @param {number} frameLimit */
  function emitFrames(frameLimit) {
    const count = Math.max(0, frameLimit - nextFrame);
    const out = new Float32Array(count * NEMOTRON_MEL_BINS);
    for (let frame = 0; frame < count; frame += 1) {
      const windowStart =
        (nextFrame + frame) * NEMOTRON_HOP_LENGTH + WINDOW_OFFSET - bufferStart;
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < WIN_LENGTH; k += 1) {
        const index = windowStart + k;
        re[WINDOW_OFFSET + k] =
          index < bufferLength ? buffer[index] * window[k] : 0;
      }
      fft.transform(re, im);
      for (let bin = 0; bin < power.length; bin += 1) {
        power[bin] = re[bin] * re[bin] + im[bin] * im[bin];
      }
      const rowOffset = frame * NEMOTRON_MEL_BINS;
      for (let mel = 0; mel < NEMOTRON_MEL_BINS; mel += 1) {
        const { start, weights } = filters[mel];
        let energy = 0;
        for (let k = 0; k < weights.length; k += 1) {
          energy += weights[k] * power[start + k];
        }
        out[rowOffset + mel] = Math.log(energy + LOG_GUARD);
      }
    }
    nextFrame += count;
    discardConsumed();
    return out;
  }

  function discardConsumed() {
    const keepFrom =
      nextFrame * NEMOTRON_HOP_LENGTH + WINDOW_OFFSET - bufferStart;
    if (keepFrom <= 0) return;
    const drop = Math.min(keepFrom, bufferLength);
    buffer.copyWithin(0, drop, bufferLength);
    bufferLength -= drop;
    bufferStart += drop;
  }

  return {
    /**
     * @param {Float32Array} samples
     * @returns {Float32Array}
     */
    push(samples) {
      if (flushed) throw new Error("Nemotron feature stream already flushed");
      if (samples.length) append(samples);
      // Frame i is complete once its window end (i*hop + 56 + 400 in padded
      // coordinates) has arrived, i.e. i*hop + 200 <= samples seen.
      const ready =
        Math.floor(
          (totalSamples - (WINDOW_OFFSET + WIN_LENGTH - CENTER_PADDING)) /
            NEMOTRON_HOP_LENGTH,
        ) + 1;
      const valid = Math.floor(totalSamples / NEMOTRON_HOP_LENGTH);
      return emitFrames(Math.max(nextFrame, Math.min(ready, valid)));
    },

    /** @returns {Float32Array} */
    flush() {
      if (flushed) return new Float32Array(0);
      flushed = true;
      return emitFrames(Math.floor(totalSamples / NEMOTRON_HOP_LENGTH));
    },

    get framesEmitted() {
      return nextFrame;
    },
  };
}

function getWindow() {
  if (sharedWindow) return sharedWindow;
  sharedWindow = new Float64Array(WIN_LENGTH);
  for (let k = 0; k < WIN_LENGTH; k += 1) {
    sharedWindow[k] =
      0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (WIN_LENGTH - 1));
  }
  return sharedWindow;
}

function getMelFilters() {
  if (!sharedFilters) {
    sharedFilters = createSlaneyMelFilters({
      sampleRate: NEMOTRON_SAMPLE_RATE,
      nFft: N_FFT,
      melBins: NEMOTRON_MEL_BINS,
      fmin: 0,
      fmax: NEMOTRON_SAMPLE_RATE / 2,
    });
  }
  return sharedFilters;
}

/**
 * Slaney-normalised mel filterbank on the Slaney mel scale (librosa's
 * `filters.mel(norm="slaney", htk=False)`), stored as sparse rows.
 * @param {{ sampleRate: number, nFft: number, melBins: number, fmin: number, fmax: number }} options
 * @returns {MelFilter[]}
 */
export function createSlaneyMelFilters({
  sampleRate,
  nFft,
  melBins,
  fmin,
  fmax,
}) {
  const bins = Math.floor(nFft / 2) + 1;
  const minMel = hzToMel(fmin);
  const maxMel = hzToMel(fmax);
  const melPoints = new Float64Array(melBins + 2);
  for (let index = 0; index < melPoints.length; index += 1) {
    melPoints[index] = melToHz(
      minMel + ((maxMel - minMel) * index) / (melBins + 1),
    );
  }
  /** @type {MelFilter[]} */
  const filters = [];
  for (let mel = 0; mel < melBins; mel += 1) {
    const lower = melPoints[mel];
    const center = melPoints[mel + 1];
    const upper = melPoints[mel + 2];
    const norm = 2 / (upper - lower);
    const row = new Float64Array(bins);
    let first = -1;
    let last = -1;
    for (let bin = 0; bin < bins; bin += 1) {
      const frequency = (bin * sampleRate) / nFft;
      const rising = (frequency - lower) / (center - lower);
      const falling = (upper - frequency) / (upper - center);
      const weight = Math.max(0, Math.min(rising, falling)) * norm;
      row[bin] = weight;
      if (weight > 0) {
        if (first < 0) first = bin;
        last = bin;
      }
    }
    filters.push(
      first < 0
        ? { start: 0, weights: new Float64Array(0) }
        : { start: first, weights: row.slice(first, last + 1) },
    );
  }
  return filters;
}

const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = Math.log(6.4) / 27;

/** @param {number} hz */
function hzToMel(hz) {
  return hz >= MIN_LOG_HZ
    ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP
    : hz / F_SP;
}

/** @param {number} mel */
function melToHz(mel) {
  return mel >= MIN_LOG_MEL
    ? MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL))
    : mel * F_SP;
}
