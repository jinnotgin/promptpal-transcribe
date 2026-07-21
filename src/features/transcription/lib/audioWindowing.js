export const AUDIO_WINDOW_SECONDS = 5 * 60;
export const AUDIO_WINDOW_OVERLAP_SECONDS = 3;

/**
 * Build fixed committed ranges with a small leading read overlap. Every upload,
 * including a file shorter than one window, uses this contract.
 *
 * @param {number} duration
 * @param {{ windowSeconds?: number, overlapSeconds?: number }} [options]
 */
export function createAudioWindows(duration, options = {}) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Audio duration must be a positive finite number");
  }

  const windowSeconds = positiveNumber(
    options.windowSeconds,
    AUDIO_WINDOW_SECONDS,
  );
  const overlapSeconds = Math.min(
    positiveNumber(options.overlapSeconds, AUDIO_WINDOW_OVERLAP_SECONDS),
    windowSeconds / 2,
  );
  const total = Math.ceil(duration / windowSeconds);
  const windows = [];

  for (let index = 0; index < total; index += 1) {
    const commitStart = index * windowSeconds;
    const commitEnd = Math.min(duration, commitStart + windowSeconds);
    windows.push({
      index,
      total,
      readStart: Math.max(0, commitStart - overlapSeconds),
      readEnd: commitEnd,
      commitStart,
      commitEnd,
      isFinal: index === total - 1,
    });
  }

  return windows;
}

/**
 * Return a zero-copy view of the committed range within one overlapping PCM
 * preparation window.
 *
 * @param {Float32Array} pcm
 * @param {{ readStart: number, readEnd: number, commitStart: number, commitEnd: number }} window
 * @param {{ sampleRate?: number }} [options]
 */
export function getCommittedPcmView(pcm, window, options = {}) {
  if (!(pcm instanceof Float32Array))
    throw new TypeError("PCM must be a Float32Array");
  const sampleRate = positiveNumber(options.sampleRate, 16000);
  const localStart = Math.max(
    0,
    Math.round((window.commitStart - window.readStart) * sampleRate),
  );
  const localEnd = Math.min(
    pcm.length,
    Math.round((window.commitEnd - window.readStart) * sampleRate),
  );
  if (localEnd <= localStart)
    throw new Error("Committed PCM range contains no samples");
  return pcm.subarray(localStart, localEnd);
}

function positiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Audio window values must be positive finite numbers");
  }
  return number;
}
