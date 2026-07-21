/**
 * Maintain a compact live RMS envelope. When the working envelope fills, pairs
 * are folded together, increasing temporal resolution while keeping memory
 * bounded independently of recording duration.
 */
export function createLiveWaveformAccumulator(options = {}) {
  const barCount = Math.max(1, Math.floor(Number(options.barCount ?? 260)));
  const maxBuckets = barCount * 2;
  /** @type {number[]} */
  let buckets = [];

  return {
    /** @param {Float32Array} pcm */
    addChunk(pcm) {
      if (!pcm?.length) return;
      let sum = 0;
      for (const rawSample of pcm) {
        const sample = Number.isFinite(rawSample) ? rawSample : 0;
        sum += sample * sample;
      }
      buckets.push(Math.sqrt(sum / pcm.length));
      if (buckets.length > maxBuckets) {
        const folded = [];
        for (let index = 0; index < buckets.length; index += 2) {
          const first = buckets[index];
          const second = buckets[index + 1] ?? first;
          folded.push(Math.sqrt((first * first + second * second) / 2));
        }
        buckets = folded;
      }
    },

    get bucketCount() {
      return buckets.length;
    },

    finalize() {
      if (!buckets.length) return [];
      const result = Array.from({ length: barCount }, (_, targetIndex) => {
        const start = Math.floor((targetIndex / barCount) * buckets.length);
        const end = Math.max(
          start + 1,
          Math.ceil(((targetIndex + 1) / barCount) * buckets.length),
        );
        const slice = buckets.slice(start, Math.min(end, buckets.length));
        if (!slice.length) return 0;
        return Math.sqrt(
          slice.reduce((sum, value) => sum + value * value, 0) / slice.length,
        );
      });
      const max = Math.max(0, ...result);
      return max > 0 ? result.map((value) => Math.min(1, value / max)) : result;
    },
  };
}
