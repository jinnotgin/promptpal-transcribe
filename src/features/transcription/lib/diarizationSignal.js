/**
 * Lightweight signal-based diarization helpers.
 *
 * This is intentionally model-free so speaker labels do not add another large
 * ONNX model/session while the local transcription pipeline is memory-bound.
 */

/** @typedef {import('./transcriptionDb.js').TranscriptSegment} TranscriptSegment */
/** @typedef {{ segmentId: string, features: number[] }} SegmentFeature */
/** @typedef {{ segmentId: string, speaker: string }} SpeakerAssignment */

const SAMPLE_RATE = 16000;
const MIN_SEGMENT_SAMPLES = 800;
const MAX_SPEAKERS = 4;

/**
 * Assign likely speakers to transcript segments.
 * @param {Float32Array} pcm
 * @param {TranscriptSegment[]} segments
 * @param {(percent: number) => void} [onProgress]
 * @returns {SpeakerAssignment[]}
 */
export function diarizeSegments(pcm, segments, onProgress) {
  const usableSegments = segments.filter(
    (segment) => segment.end > segment.start,
  );
  if (usableSegments.length === 0) return [];

  const features = usableSegments.map((segment, index) => {
    const feature = extractSegmentFeature(pcm, segment);
    if (onProgress) onProgress((index / usableSegments.length) * 45);
    return {
      segmentId: segment.id,
      features: feature,
    };
  });

  if (features.length <= 1) {
    if (onProgress) onProgress(100);
    return features.map((feature) => ({
      segmentId: feature.segmentId,
      speaker: "Speaker 1",
    }));
  }

  const normalized = normalizeFeatures(features);
  const speakerCount = chooseSpeakerCount(normalized);
  const clusters = kMeans(normalized, speakerCount);
  const smoothed = smoothAssignments(clusters);

  if (onProgress) onProgress(100);

  return normalized.map((feature, index) => ({
    segmentId: feature.segmentId,
    speaker: `Speaker ${smoothed[index] + 1}`,
  }));
}

/**
 * @param {Float32Array} pcm
 * @param {TranscriptSegment} segment
 * @returns {number[]}
 */
function extractSegmentFeature(pcm, segment) {
  const startSample = Math.max(0, Math.floor(segment.start * SAMPLE_RATE));
  const endSample = Math.min(pcm.length, Math.ceil(segment.end * SAMPLE_RATE));
  const length = endSample - startSample;

  if (length < MIN_SEGMENT_SAMPLES) {
    return [0, 0, 0, 0, 0];
  }

  let sumSquares = 0;
  let sumAbs = 0;
  let zeroCrossings = 0;
  let previous = pcm[startSample];

  for (let i = startSample; i < endSample; i++) {
    const sample = pcm[i];
    sumSquares += sample * sample;
    sumAbs += Math.abs(sample);
    if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) {
      zeroCrossings++;
    }
    previous = sample;
  }

  const rms = Math.sqrt(sumSquares / length);
  const meanAbs = sumAbs / length;
  const zcr = zeroCrossings / length;
  const pitch = estimatePitch(pcm, startSample, endSample);
  const dynamicRange = estimateDynamicRange(pcm, startSample, endSample);

  return [
    Math.log10(rms + 1e-6),
    Math.log10(meanAbs + 1e-6),
    zcr,
    pitch / 400,
    dynamicRange,
  ];
}

/**
 * @param {Float32Array} pcm
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function estimatePitch(pcm, start, end) {
  const maxSamples = Math.min(end - start, SAMPLE_RATE);
  if (maxSamples < 1024) return 0;

  const minLag = Math.floor(SAMPLE_RATE / 350);
  const maxLag = Math.floor(SAMPLE_RATE / 80);
  let bestLag = 0;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    let energyA = 0;
    let energyB = 0;

    for (let i = 0; i < maxSamples - lag; i += 4) {
      const a = pcm[start + i];
      const b = pcm[start + i + lag];
      correlation += a * b;
      energyA += a * a;
      energyB += b * b;
    }

    const normalized = correlation / Math.sqrt(energyA * energyB + 1e-9);
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized;
      bestLag = lag;
    }
  }

  return bestCorrelation > 0.25 && bestLag > 0 ? SAMPLE_RATE / bestLag : 0;
}

/**
 * @param {Float32Array} pcm
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function estimateDynamicRange(pcm, start, end) {
  const frameSize = 800;
  const energies = [];

  for (let offset = start; offset + frameSize <= end; offset += frameSize) {
    let sumSquares = 0;
    for (let i = 0; i < frameSize; i++) {
      const sample = pcm[offset + i];
      sumSquares += sample * sample;
    }
    energies.push(Math.sqrt(sumSquares / frameSize));
  }

  if (energies.length < 2) return 0;
  energies.sort((a, b) => a - b);
  const low = energies[Math.floor(energies.length * 0.1)];
  const high = energies[Math.floor(energies.length * 0.9)];
  return Math.log10((high + 1e-6) / (low + 1e-6));
}

/**
 * @param {SegmentFeature[]} features
 * @returns {SegmentFeature[]}
 */
function normalizeFeatures(features) {
  const dimensions = features[0].features.length;
  const means = new Array(dimensions).fill(0);
  const stddevs = new Array(dimensions).fill(0);

  for (const feature of features) {
    for (let i = 0; i < dimensions; i++) {
      means[i] += feature.features[i];
    }
  }
  for (let i = 0; i < dimensions; i++) {
    means[i] /= features.length;
  }

  for (const feature of features) {
    for (let i = 0; i < dimensions; i++) {
      const diff = feature.features[i] - means[i];
      stddevs[i] += diff * diff;
    }
  }
  for (let i = 0; i < dimensions; i++) {
    stddevs[i] = Math.sqrt(stddevs[i] / features.length) || 1;
  }

  return features.map((feature) => ({
    segmentId: feature.segmentId,
    features: feature.features.map(
      (value, index) => (value - means[index]) / stddevs[index],
    ),
  }));
}

/**
 * @param {SegmentFeature[]} features
 * @returns {number}
 */
function chooseSpeakerCount(features) {
  const maxK = Math.min(
    MAX_SPEAKERS,
    Math.max(1, Math.floor(Math.sqrt(features.length))),
  );
  if (maxK <= 1 || features.length < 4) return 1;

  let bestK = 1;
  let bestScore = -Infinity;

  for (let k = 1; k <= maxK; k++) {
    const assignments = kMeans(features, k);
    const score = silhouetteScore(features, assignments, k);
    if (score > bestScore + 0.05) {
      bestScore = score;
      bestK = k;
    }
  }

  return bestScore > 0.18 ? bestK : 1;
}

/**
 * @param {SegmentFeature[]} features
 * @param {number} k
 * @returns {number[]}
 */
function kMeans(features, k) {
  if (k <= 1) return new Array(features.length).fill(0);

  const centroids = initializeCentroids(features, k);
  const assignments = new Array(features.length).fill(0);

  for (let iteration = 0; iteration < 20; iteration++) {
    let changed = false;

    for (let i = 0; i < features.length; i++) {
      let bestCluster = 0;
      let bestDistance = Infinity;

      for (let cluster = 0; cluster < k; cluster++) {
        const distance = squaredDistance(
          features[i].features,
          centroids[cluster],
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = cluster;
        }
      }

      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }

    if (!changed) break;
    recomputeCentroids(features, assignments, centroids);
  }

  return remapClustersByFirstUse(assignments);
}

/**
 * @param {SegmentFeature[]} features
 * @param {number} k
 * @returns {number[][]}
 */
function initializeCentroids(features, k) {
  const centroids = [features[0].features.slice()];

  while (centroids.length < k) {
    let farthest = features[0].features;
    let farthestDistance = -Infinity;

    for (const feature of features) {
      const nearestDistance = Math.min(
        ...centroids.map((centroid) =>
          squaredDistance(feature.features, centroid),
        ),
      );
      if (nearestDistance > farthestDistance) {
        farthestDistance = nearestDistance;
        farthest = feature.features;
      }
    }

    centroids.push(farthest.slice());
  }

  return centroids;
}

/**
 * @param {SegmentFeature[]} features
 * @param {number[]} assignments
 * @param {number[][]} centroids
 */
function recomputeCentroids(features, assignments, centroids) {
  const dimensions = centroids[0].length;
  const counts = new Array(centroids.length).fill(0);
  const sums = centroids.map(() => new Array(dimensions).fill(0));

  for (let i = 0; i < features.length; i++) {
    const cluster = assignments[i];
    counts[cluster]++;
    for (let d = 0; d < dimensions; d++) {
      sums[cluster][d] += features[i].features[d];
    }
  }

  for (let cluster = 0; cluster < centroids.length; cluster++) {
    if (counts[cluster] === 0) continue;
    for (let d = 0; d < dimensions; d++) {
      centroids[cluster][d] = sums[cluster][d] / counts[cluster];
    }
  }
}

/**
 * @param {SegmentFeature[]} features
 * @param {number[]} assignments
 * @param {number} k
 * @returns {number}
 */
function silhouetteScore(features, assignments, k) {
  if (k <= 1) return 0;

  let total = 0;
  for (let i = 0; i < features.length; i++) {
    const ownCluster = assignments[i];
    let ownDistance = 0;
    let ownCount = 0;
    const otherDistances = new Array(k).fill(0);
    const otherCounts = new Array(k).fill(0);

    for (let j = 0; j < features.length; j++) {
      if (i === j) continue;
      const distance = Math.sqrt(
        squaredDistance(features[i].features, features[j].features),
      );
      const cluster = assignments[j];
      if (cluster === ownCluster) {
        ownDistance += distance;
        ownCount++;
      } else {
        otherDistances[cluster] += distance;
        otherCounts[cluster]++;
      }
    }

    const a = ownCount > 0 ? ownDistance / ownCount : 0;
    let b = Infinity;
    for (let cluster = 0; cluster < k; cluster++) {
      if (cluster === ownCluster || otherCounts[cluster] === 0) continue;
      b = Math.min(b, otherDistances[cluster] / otherCounts[cluster]);
    }

    if (Number.isFinite(b)) {
      total += (b - a) / Math.max(a, b, 1e-6);
    }
  }

  return total / features.length;
}

/**
 * @param {number[]} assignments
 * @returns {number[]}
 */
function smoothAssignments(assignments) {
  const smoothed = assignments.slice();
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (
      smoothed[i - 1] === smoothed[i + 1] &&
      smoothed[i] !== smoothed[i - 1]
    ) {
      smoothed[i] = smoothed[i - 1];
    }
  }
  return remapClustersByFirstUse(smoothed);
}

/**
 * @param {number[]} assignments
 * @returns {number[]}
 */
function remapClustersByFirstUse(assignments) {
  const clusterMap = new Map();
  let next = 0;
  return assignments.map((cluster) => {
    if (!clusterMap.has(cluster)) {
      clusterMap.set(cluster, next++);
    }
    return clusterMap.get(cluster);
  });
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function squaredDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}
