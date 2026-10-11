/**
 * Converts frame-level speaker probabilities into labelled time ranges.
 *
 * Segment ids are 1-based to match the transcript-processing core, which maps
 * id 1 to "Speaker A". Speakers are renumbered by first appearance so labels
 * stay contiguous when a model channel never becomes active.
 */

/**
 * @typedef {{ probs: Float32Array, frames: number, numSpeakers: number, frameSeconds: number }} SpeakerProbabilities
 * @typedef {{ id: number, start: number, end: number }} SpeakerSegment
 */

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_GAP_SECONDS = 0.2;
const DEFAULT_MIN_SEGMENT_SECONDS = 0.15;

/**
 * Per-speaker activity segments; overlapping speech yields overlapping
 * segments.
 * @param {SpeakerProbabilities} input
 * @param {{ threshold?: number, minGapSeconds?: number, minSegmentSeconds?: number }} [options]
 * @returns {SpeakerSegment[]}
 */
export function probabilitiesToSpeakerSegments(input, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minGap = options.minGapSeconds ?? DEFAULT_MIN_GAP_SECONDS;
  const minSegment = options.minSegmentSeconds ?? DEFAULT_MIN_SEGMENT_SECONDS;
  const { probs, frames, numSpeakers, frameSeconds } = input;

  /** @type {Array<{ speaker: number, start: number, end: number }>} */
  const segments = [];
  for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
    /** @type {Array<{ speaker: number, start: number, end: number }>} */
    const ranges = [];
    let start = -1;
    for (let frame = 0; frame <= frames; frame += 1) {
      const active =
        frame < frames && probs[frame * numSpeakers + speaker] > threshold;
      if (active && start < 0) start = frame;
      if (!active && start >= 0) {
        const range = {
          speaker,
          start: start * frameSeconds,
          end: frame * frameSeconds,
        };
        const previous = ranges[ranges.length - 1];
        if (previous && range.start - previous.end <= minGap)
          previous.end = range.end;
        else ranges.push(range);
        start = -1;
      }
    }
    segments.push(
      ...ranges.filter((range) => range.end - range.start >= minSegment),
    );
  }

  segments.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
  const ids = new Map();
  return segments.map((segment) => {
    if (!ids.has(segment.speaker)) ids.set(segment.speaker, ids.size + 1);
    return {
      id: ids.get(segment.speaker),
      start: roundTime(segment.start),
      end: roundTime(segment.end),
    };
  });
}

/**
 * Rasterise speaker segments (0-based `speaker`) into a 0/1 activity grid so
 * segment-based diarizers can reuse the probability helpers above.
 * @param {Array<{ start: number, end: number, speaker: number }>} segments
 * @param {{ frameSeconds?: number }} [options]
 * @returns {SpeakerProbabilities}
 */
export function segmentsToProbabilities(segments, options = {}) {
  const frameSeconds = options.frameSeconds ?? 0.01;
  const numSpeakers = Math.max(
    1,
    ...segments.map((segment) => segment.speaker + 1),
  );
  const frames = segments.length
    ? Math.round(Math.max(...segments.map((s) => s.end)) / frameSeconds)
    : 0;
  const probs = new Float32Array(frames * numSpeakers);
  for (const { start, end, speaker } of segments) {
    const first = Math.max(0, Math.round(start / frameSeconds));
    const last = Math.min(frames, Math.round(end / frameSeconds));
    for (let frame = first; frame < last; frame += 1) {
      probs[frame * numSpeakers + speaker] = 1;
    }
  }
  return { probs, frames, numSpeakers, frameSeconds };
}

/** @param {number} value */
function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}
