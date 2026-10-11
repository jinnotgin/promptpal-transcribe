/**
 * Streaming port of sherpa-onnx's offline pyannote speaker diarization
 * (`OfflineSpeakerDiarizationPyannoteImpl`, Apache-2.0), for groups larger
 * than Nemotron's 8 speakers.
 *
 * 1. pyannote segmentation-3.0 runs on 10 s chunks every 1 s; each chunk's
 *    powerset output names up to 3 local speakers per frame.
 * 2. For every (chunk, local speaker) with enough non-overlapped speech, a
 *    speaker embedding is computed from that speech.
 * 3. Embeddings are clustered into the user-given number of speakers, and
 *    the per-frame speaker count picks the top clusters for each frame.
 *
 * Unlike the C++ original, audio is consumed incrementally: segmentation and
 * embeddings run as soon as a chunk is complete, so only one chunk of audio
 * is retained however long the recording is.
 */

import { SHERPA_FBANK_BINS, computeSherpaFbank } from "./sherpaFbank.js";
import { clusterSpeakerEmbeddings } from "./speakerClustering.js";

/**
 * @typedef {{
 *   windowSize: number,
 *   windowShift: number,
 *   receptiveFieldSize: number,
 *   receptiveFieldShift: number,
 *   numSpeakers: number,
 *   numClasses: number,
 *   sampleRate: number,
 * }} SegmentationMeta
 * @typedef {(chunk: Float32Array) => Promise<{ logits: Float32Array, frames: number }>} RunSegmentation
 *   `chunk` holds `windowSize` samples; logits are frame-major [frames, numClasses]
 * @typedef {(features: Float32Array, frames: number) => Promise<Float32Array>} RunEmbedding
 *   features are frame-major [frames, 80] after global-mean normalisation
 * @typedef {(audio: Float32Array) => { features: Float32Array, frames: number }} EmbeddingFeatures
 * @typedef {{ start: number, end: number, speaker: number }} SherpaSegment
 */

/** pyannote/segmentation-3.0 as exported by sherpa-onnx (model metadata). */
export const PYANNOTE_SEGMENTATION_META = Object.freeze({
  windowSize: 160000,
  windowShift: 16000,
  receptiveFieldSize: 991,
  receptiveFieldShift: 270,
  numSpeakers: 3,
  numClasses: 7,
  sampleRate: 16000,
});

const MIN_EMBEDDING_FRAMES = 10;
const MIN_DURATION_ON = 0.3;
const MIN_DURATION_OFF = 0.5;

/**
 * @param {{
 *   runSegmentation: RunSegmentation,
 *   runEmbedding: RunEmbedding,
 *   embeddingFeatures?: EmbeddingFeatures,
 *   numClusters?: number,
 *   threshold?: number,
 *   meta?: SegmentationMeta,
 *   onChunk?: (processedSeconds: number) => void,
 * }} options `onChunk` reports how far the audio has been diarized
 */
export function createSherpaDiarizer({
  runSegmentation,
  runEmbedding,
  embeddingFeatures = normalizedFbank,
  numClusters = 0,
  threshold = 0.5,
  meta = PYANNOTE_SEGMENTATION_META,
  onChunk,
}) {
  const { windowSize, windowShift } = meta;
  const powerset = powersetMapping(meta.numClasses, meta.numSpeakers);

  /** @type {Int8Array[]} per chunk, frame-major [frames, numSpeakers] */
  const chunkLabels = [];
  /** @type {Float32Array[]} */
  const embeddings = [];
  /** @type {Array<{ chunk: number, speaker: number }>} */
  const embeddingOwners = [];

  // Samples from the next chunk's start onwards.
  let buffer = new Float32Array(windowSize * 2);
  let buffered = 0;
  let totalSamples = 0;
  let finished = false;

  /**
   * @param {Float32Array} pcm 16 kHz mono samples
   */
  async function pushPcm(pcm) {
    if (finished) throw new Error("Diarizer already finished");
    totalSamples += pcm.length;
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(pcm.length - offset, buffer.length - buffered);
      buffer.set(pcm.subarray(offset, offset + take), buffered);
      buffered += take;
      offset += take;
      while (buffered >= windowSize) {
        await processChunk(buffer.subarray(0, windowSize), totalSamples);
        buffer.copyWithin(0, windowShift, buffered);
        buffered -= windowShift;
        onChunk?.((chunkLabels.length * windowShift) / meta.sampleRate);
      }
    }
  }

  /**
   * @param {Float32Array} chunk exactly `windowSize` samples
   * @param {number} validSamples absolute sample count known so far
   */
  async function processChunk(chunk, validSamples) {
    const index = chunkLabels.length;
    const { logits, frames } = await runSegmentation(chunk);
    const labels = toMultiLabel(logits, frames, meta.numClasses, powerset);
    chunkLabels.push(labels);
    const sampleOffset = index * windowShift;
    for (const { speaker, ranges } of chunkSpeakerRanges(
      labels,
      frames,
      meta,
      sampleOffset,
    )) {
      const audio = gatherRanges(chunk, ranges, sampleOffset, validSamples);
      if (!audio.length) continue;
      const { features, frames: featureFrames } = embeddingFeatures(audio);
      if (!featureFrames) continue;
      const embedding = await runEmbedding(features, featureFrames);
      if (embedding.some(Number.isNaN)) continue;
      embeddings.push(Float32Array.from(embedding));
      embeddingOwners.push({ chunk: index, speaker });
    }
  }

  /**
   * Flush the final partial chunk and cluster.
   * @returns {Promise<SherpaSegment[]>} sorted by start time; speaker ids
   *   are 0-based cluster indexes
   */
  async function finish() {
    if (finished) throw new Error("Diarizer already finished");
    finished = true;
    const n = totalSamples;
    if (n <= 0) return [];
    if (n <= windowSize) {
      if (!chunkLabels.length) {
        const padded = new Float32Array(windowSize);
        padded.set(buffer.subarray(0, buffered));
        const { logits, frames } = await runSegmentation(padded);
        chunkLabels.push(
          toMultiLabel(logits, frames, meta.numClasses, powerset),
        );
      }
      return oneChunkResult(chunkLabels[0], n);
    }
    if ((n - windowSize) % windowShift > 0) {
      const padded = new Float32Array(windowSize);
      padded.set(buffer.subarray(0, buffered));
      await processChunk(padded, n);
    }
    buffer = new Float32Array(0);

    const speakersPerFrame = computeSpeakersPerFrame(chunkLabels, meta);
    if (!speakersPerFrame.some((count) => count > 0)) return [];
    const rows = embeddings.length;
    if (!rows) return [];
    const dim = embeddings[0].length;
    const matrix = new Float32Array(rows * dim);
    embeddings.forEach((embedding, row) => matrix.set(embedding, row * dim));
    const clusters = clusterSpeakerEmbeddings(matrix, rows, {
      numClusters,
      threshold,
    });
    let maxCluster = 0;
    for (const cluster of clusters) maxCluster = Math.max(maxCluster, cluster);
    /** @type {Map<string, number>} */
    const toCluster = new Map();
    embeddingOwners.forEach(({ chunk, speaker }, row) =>
      toCluster.set(`${chunk}:${speaker}`, clusters[row]),
    );
    const count = computeSpeakerCount(
      chunkLabels,
      toCluster,
      maxCluster + 1,
      meta,
      n,
    );
    const finalLabels = finalizeLabels(count, speakersPerFrame, maxCluster + 1);
    return computeResult(finalLabels, maxCluster + 1, meta);
  }

  /**
   * @param {Int8Array} labels
   * @param {number} n
   */
  function oneChunkResult(labels, n) {
    const frames = labels.length / meta.numSpeakers;
    const hasLastChunk = (n - windowSize) % windowShift > 0;
    const keep = hasLastChunk
      ? Math.min(Math.floor(n / meta.receptiveFieldShift), frames)
      : frames;
    return computeResult(
      labels.subarray(0, keep * meta.numSpeakers),
      meta.numSpeakers,
      meta,
    );
  }

  return {
    pushPcm,
    finish,
    /** Number of (chunk, speaker) embeddings computed so far. */
    get embeddingCount() {
      return embeddings.length;
    },
  };
}

/**
 * pyannote's powerset: class 0 is silence, then single speakers, then pairs.
 * @param {number} numClasses
 * @param {number} numSpeakers
 */
export function powersetMapping(numClasses, numSpeakers) {
  const mapping = new Int8Array(numClasses * numSpeakers);
  let k = 1;
  for (let j = 0; j < numSpeakers; j += 1, k += 1) {
    mapping[k * numSpeakers + j] = 1;
  }
  for (let j = 0; j < numSpeakers; j += 1) {
    for (let m = j + 1; m < numSpeakers; m += 1, k += 1) {
      mapping[k * numSpeakers + j] = 1;
      mapping[k * numSpeakers + m] = 1;
    }
  }
  return mapping;
}

/**
 * @param {Float32Array} logits [frames, numClasses]
 * @param {number} frames
 * @param {number} numClasses
 * @param {Int8Array} mapping [numClasses, numSpeakers]
 */
function toMultiLabel(logits, frames, numClasses, mapping) {
  const numSpeakers = mapping.length / numClasses;
  const labels = new Int8Array(frames * numSpeakers);
  for (let frame = 0; frame < frames; frame += 1) {
    let best = 0;
    for (let c = 1; c < numClasses; c += 1) {
      if (logits[frame * numClasses + c] > logits[frame * numClasses + best]) {
        best = c;
      }
    }
    labels.set(
      mapping.subarray(best * numSpeakers, (best + 1) * numSpeakers),
      frame * numSpeakers,
    );
  }
  return labels;
}

/**
 * Sample ranges of each local speaker's non-overlapped speech in one chunk
 * (`GetChunkSpeakerSampleIndexes`); speakers under 10 frames are skipped.
 * @param {Int8Array} labels
 * @param {number} frames
 * @param {SegmentationMeta} meta
 * @param {number} sampleOffset
 * @returns {Array<{ speaker: number, ranges: Array<[number, number]> }>}
 */
export function chunkSpeakerRanges(labels, frames, meta, sampleOffset) {
  const { numSpeakers, windowSize } = meta;
  const toSample = (/** @type {number} */ frame) =>
    Math.trunc(Math.fround(Math.fround(frame / frames) * windowSize)) +
    sampleOffset;
  const solo = (/** @type {number} */ frame, /** @type {number} */ speaker) => {
    let active = 0;
    for (let s = 0; s < numSpeakers; s += 1) {
      active += labels[frame * numSpeakers + s];
    }
    return active < 2 && labels[frame * numSpeakers + speaker] === 1;
  };
  const out = [];
  for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
    let total = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      if (solo(frame, speaker)) total += 1;
    }
    if (total < MIN_EMBEDDING_FRAMES) continue;
    /** @type {Array<[number, number]>} */
    const ranges = [];
    let start = -1;
    for (let frame = 0; frame < frames; frame += 1) {
      if (solo(frame, speaker)) {
        if (start < 0) start = frame;
      } else if (start >= 0) {
        ranges.push([toSample(start), toSample(frame)]);
        start = -1;
      }
    }
    if (start >= 0) ranges.push([toSample(start), toSample(frames - 1)]);
    out.push({ speaker, ranges });
  }
  return out;
}

/**
 * @param {Float32Array} chunk
 * @param {Array<[number, number]>} ranges absolute samples
 * @param {number} sampleOffset absolute start of `chunk`
 * @param {number} limit absolute end of real audio
 */
function gatherRanges(chunk, ranges, sampleOffset, limit) {
  let length = 0;
  for (const [start, end] of ranges) {
    length += Math.max(0, Math.min(end, limit) - start);
  }
  const audio = new Float32Array(length);
  let offset = 0;
  for (const [start, end] of ranges) {
    const stop = Math.min(end, limit);
    if (stop <= start) continue;
    audio.set(
      chunk.subarray(start - sampleOffset, stop - sampleOffset),
      offset,
    );
    offset += stop - start;
  }
  return audio;
}

/**
 * sherpa-onnx's embedding input: fbank with the utterance mean removed
 * (`feature_normalize_type = global-mean`).
 * @param {Float32Array} audio
 */
function normalizedFbank(audio) {
  const fbank = computeSherpaFbank(audio);
  if (fbank.frames) {
    subtractGlobalMean(fbank.features, fbank.frames, SHERPA_FBANK_BINS);
  }
  return fbank;
}

/**
 * @param {Float32Array} features
 * @param {number} frames
 * @param {number} dim
 */
function subtractGlobalMean(features, frames, dim) {
  const mean = new Float64Array(dim);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let k = 0; k < dim; k += 1) mean[k] += features[frame * dim + k];
  }
  for (let k = 0; k < dim; k += 1) mean[k] /= frames;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let k = 0; k < dim; k += 1) features[frame * dim + k] -= mean[k];
  }
}

/**
 * Global frame count and per-chunk frame offset.
 * @param {number} chunks
 * @param {SegmentationMeta} meta
 */
function globalFrames(chunks, meta) {
  return {
    total:
      Math.trunc(
        (meta.windowSize + (chunks - 1) * meta.windowShift) /
          meta.receptiveFieldShift,
      ) + 1,
    startOf: (/** @type {number} */ chunk) =>
      Math.trunc((chunk * meta.windowShift) / meta.receptiveFieldShift + 0.5),
  };
}

/**
 * Average number of active local speakers per global frame, rounded.
 * @param {Int8Array[]} labels
 * @param {SegmentationMeta} meta
 */
function computeSpeakersPerFrame(labels, meta) {
  const { total, startOf } = globalFrames(labels.length, meta);
  const count = new Float32Array(total);
  const weight = new Float32Array(total);
  labels.forEach((chunk, index) => {
    const start = startOf(index);
    const frames = chunk.length / meta.numSpeakers;
    for (let frame = 0; frame < frames && start + frame < total; frame += 1) {
      let active = 0;
      for (let s = 0; s < meta.numSpeakers; s += 1) {
        active += chunk[frame * meta.numSpeakers + s];
      }
      count[start + frame] += active;
      weight[start + frame] += 1;
    }
  });
  const out = new Int32Array(total);
  for (let frame = 0; frame < total; frame += 1) {
    out[frame] = Math.trunc(count[frame] / (weight[frame] + 1e-12) + 0.5);
  }
  return out;
}

/**
 * Per-frame activity count of each cluster, trimmed to the real audio.
 * @param {Int8Array[]} labels
 * @param {Map<string, number>} toCluster
 * @param {number} clusters
 * @param {SegmentationMeta} meta
 * @param {number} numSamples
 */
function computeSpeakerCount(labels, toCluster, clusters, meta, numSamples) {
  const { total, startOf } = globalFrames(labels.length, meta);
  const count = new Int32Array(total * clusters);
  labels.forEach((chunk, index) => {
    const start = startOf(index);
    const frames = chunk.length / meta.numSpeakers;
    for (let s = 0; s < meta.numSpeakers; s += 1) {
      const cluster = toCluster.get(`${index}:${s}`);
      if (cluster === undefined) continue;
      for (let frame = 0; frame < frames && start + frame < total; frame += 1) {
        if (chunk[frame * meta.numSpeakers + s] === 1) {
          count[(start + frame) * clusters + cluster] += 1;
        }
      }
    }
  });
  if ((numSamples - meta.windowSize) % meta.windowShift <= 0) return count;
  const lastFrame = Math.min(
    Math.trunc(numSamples / meta.receptiveFieldShift),
    total - 1,
  );
  return count.subarray(0, (lastFrame + 1) * clusters);
}

/**
 * Mark the `speakersPerFrame[i]` most active clusters of each frame.
 * @param {Int32Array} count [frames, clusters]
 * @param {Int32Array} speakersPerFrame
 * @param {number} clusters
 */
function finalizeLabels(count, speakersPerFrame, clusters) {
  const frames = count.length / clusters;
  const labels = new Int8Array(count.length);
  const order = Array.from({ length: clusters }, (_, index) => index);
  for (let frame = 0; frame < frames; frame += 1) {
    const k = Math.min(speakersPerFrame[frame] ?? 0, clusters);
    if (k <= 0) continue;
    const row = frame * clusters;
    order.sort((a, b) => count[row + b] - count[row + a] || a - b);
    for (let i = 0; i < k; i += 1) labels[row + order[i]] = 1;
  }
  return labels;
}

/**
 * Frame labels to merged per-speaker segments, sorted by start time.
 * @param {Int8Array} labels [frames, speakers]
 * @param {number} speakers
 * @param {SegmentationMeta} meta
 * @returns {SherpaSegment[]}
 */
function computeResult(labels, speakers, meta) {
  const frames = labels.length / speakers;
  const scale = meta.receptiveFieldShift / meta.sampleRate;
  const offset = (0.5 * meta.receptiveFieldSize) / meta.sampleRate;
  const time = (/** @type {number} */ frame) => frame * scale + offset;
  /** @type {SherpaSegment[]} */
  const result = [];
  for (let speaker = 0; speaker < speakers; speaker += 1) {
    /** @type {SherpaSegment[]} */
    const own = [];
    let active = frames > 0 && labels[speaker] > 0;
    let start = active ? 0 : -1;
    for (let frame = 1; frame < frames; frame += 1) {
      const on = labels[frame * speakers + speaker] === 1;
      if (active && !on) {
        own.push({ start: time(start), end: time(frame), speaker });
        active = false;
      } else if (!active && on) {
        active = true;
        start = frame;
      }
    }
    if (active)
      own.push({ start: time(start), end: time(frames - 1), speaker });
    for (let i = 0; i < own.length - 1; ) {
      const a = own[i];
      const b = own[i + 1];
      if (a.end < b.start && a.end + MIN_DURATION_OFF >= b.start) {
        own.splice(i, 2, { start: a.start, end: b.end, speaker });
        i = 0;
      } else i += 1;
    }
    result.push(...own.filter((s) => s.end - s.start > MIN_DURATION_ON));
  }
  return result.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
}
