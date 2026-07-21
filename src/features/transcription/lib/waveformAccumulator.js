/**
 * Incrementally reduce canonical PCM into a fixed-size RMS envelope. Only the
 * committed part of an overlapping window contributes to the result.
 *
 * @param {{ duration: number, sampleRate?: number, barCount?: number }} options
 */
export function createWaveformAccumulator(options) {
  const duration = Number(options.duration);
  const sampleRate = Number(options.sampleRate ?? 16000);
  const barCount = Math.max(1, Math.floor(Number(options.barCount ?? 260)));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Waveform duration must be a positive finite number");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Waveform sample rate must be a positive finite number");
  }

  const sums = new Float64Array(barCount);
  const counts = new Uint32Array(barCount);

  return {
    /**
     * @param {Float32Array} pcm
     * @param {{ readStart: number, commitStart: number, commitEnd: number }} window
     */
    addWindow(pcm, window) {
      const localStart = Math.max(
        0,
        Math.round((window.commitStart - window.readStart) * sampleRate),
      );
      const localEnd = Math.min(
        pcm.length,
        Math.round((window.commitEnd - window.readStart) * sampleRate),
      );

      for (let index = localStart; index < localEnd; index += 1) {
        const absoluteTime = window.readStart + index / sampleRate;
        const barIndex = Math.min(
          barCount - 1,
          Math.max(0, Math.floor((absoluteTime / duration) * barCount)),
        );
        const sample = Number.isFinite(pcm[index]) ? pcm[index] : 0;
        sums[barIndex] += sample * sample;
        counts[barIndex] += 1;
      }
    },

    finalize() {
      const rms = Array.from(sums, (sum, index) =>
        counts[index] ? Math.sqrt(sum / counts[index]) : 0,
      );
      const max = Math.max(0, ...rms);
      if (max === 0) return rms;
      return rms.map((value) => Math.min(1, Math.max(0, value / max)));
    },
  };
}

/**
 * Normalize untrusted persisted waveform samples.
 * @param {unknown} value
 * @param {number} [barCount]
 */
export function normalizeWaveformSamples(value, barCount = 260) {
  if (!Array.isArray(value) || value.length !== barCount) return [];
  return value.map((sample) => {
    const number = Number(sample);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
  });
}
