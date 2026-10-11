/**
 * Timestamp decoding for Qwen3-ForcedAligner (qwen-asr 0.0.6, Apache-2.0).
 *
 * Each `<timestamp>` slot predicts a class; class × 80 ms is a time in the
 * aligned clip. Slots that break monotonicity are repaired as in
 * `Qwen3ForceAlignProcessor.fix_timestamp`: the longest non-decreasing
 * subsequence is kept, runs of up to two outliers snap to the nearer
 * neighbour and longer runs are interpolated.
 */

export const ALIGNER_SEGMENT_SECONDS = 0.08;

/**
 * @param {ArrayLike<number>} values
 * @returns {number[]}
 */
export function repairAlignerTimestamps(values) {
  const data = Array.from(values);
  const n = data.length;
  if (!n) return [];
  const dp = new Array(n).fill(1);
  const parent = new Array(n).fill(-1);
  for (let i = 1; i < n; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (data[j] <= data[i] && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1;
        parent[i] = j;
      }
    }
  }
  let index = dp.indexOf(Math.max(...dp));
  const normal = new Array(n).fill(false);
  while (index !== -1) {
    normal[index] = true;
    index = parent[index];
  }

  const result = data.slice();
  let i = 0;
  while (i < n) {
    if (normal[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && !normal[j]) j += 1;
    let left = null;
    for (let k = i - 1; k >= 0; k -= 1) {
      if (normal[k]) {
        left = result[k];
        break;
      }
    }
    let right = null;
    for (let k = j; k < n; k += 1) {
      if (normal[k]) {
        right = result[k];
        break;
      }
    }
    const count = j - i;
    for (let k = i; k < j; k += 1) {
      if (left === null) result[k] = right;
      else if (right === null) result[k] = left;
      else if (count <= 2) result[k] = k - (i - 1) <= j - k ? left : right;
      else result[k] = left + ((right - left) / (count + 1)) * (k - i + 1);
    }
    i = j;
  }
  return result.map((value) => Math.trunc(value));
}

/**
 * @param {ArrayLike<number>} classes predicted class per timestamp slot
 * @param {number} units number of aligned units (two slots each)
 * @param {{ offset?: number }} [options] clip start in seconds
 * @returns {Array<{ start: number, end: number }>}
 */
export function alignedUnitTimes(classes, units, options = {}) {
  const offset = options.offset ?? 0;
  const ms = repairAlignerTimestamps(
    Array.from(classes, (value) => value * ALIGNER_SEGMENT_SECONDS * 1000),
  );
  const times = [];
  for (let unit = 0; unit < units; unit += 1) {
    times.push({
      start: round(offset + ms[unit * 2] / 1000),
      end: round(offset + ms[unit * 2 + 1] / 1000),
    });
  }
  return times;
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1000) / 1000;
}
