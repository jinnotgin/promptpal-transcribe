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
const DEFAULT_MIN_TURN_SECONDS = 0.3;

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
 * Non-overlapping turns: each active frame goes to its most probable
 * speaker, and turns shorter than `minTurnSeconds` are absorbed by a
 * neighbour. Used to cut audio into single-speaker regions before ASR.
 * @param {SpeakerProbabilities} input
 * @param {{ threshold?: number, minGapSeconds?: number, minTurnSeconds?: number }} [options]
 * @returns {SpeakerSegment[]}
 */
export function dominantSpeakerTurns(input, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minGap = options.minGapSeconds ?? DEFAULT_MIN_GAP_SECONDS;
  const minTurn = options.minTurnSeconds ?? DEFAULT_MIN_TURN_SECONDS;
  const { probs, frames, numSpeakers, frameSeconds } = input;

  /** @type {Array<{ speaker: number, start: number, end: number }>} */
  let turns = [];
  for (let frame = 0; frame < frames; frame += 1) {
    let best = -1;
    let bestProb = threshold;
    for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
      const prob = probs[frame * numSpeakers + speaker];
      if (prob > bestProb) {
        best = speaker;
        bestProb = prob;
      }
    }
    if (best < 0) continue;
    const start = frame * frameSeconds;
    const end = start + frameSeconds;
    const previous = turns[turns.length - 1];
    if (
      previous &&
      previous.speaker === best &&
      start - previous.end <= minGap
    ) {
      previous.end = end;
    } else {
      turns.push({ speaker: best, start, end });
    }
  }

  turns = absorbShortTurns(turns, minTurn, minGap);

  const ids = new Map();
  return turns.map((turn) => {
    if (!ids.has(turn.speaker)) ids.set(turn.speaker, ids.size + 1);
    return {
      id: ids.get(turn.speaker),
      start: roundTime(turn.start),
      end: roundTime(turn.end),
    };
  });
}

/**
 * @param {Array<{ speaker: number, start: number, end: number }>} turns
 * @param {number} minTurn
 * @param {number} minGap
 */
function absorbShortTurns(turns, minTurn, minGap) {
  let changed = true;
  let current = turns.map((turn) => ({ ...turn }));
  while (changed) {
    changed = false;
    /** @type {typeof current} */
    const next = [];
    for (let index = 0; index < current.length; index += 1) {
      const turn = current[index];
      const previous = next[next.length - 1];
      const following = current[index + 1];
      const isShort = turn.end - turn.start < minTurn;
      if (isShort && previous && turn.start - previous.end <= minGap) {
        previous.end = turn.end;
        changed = true;
        continue;
      }
      if (isShort && following && following.start - turn.end <= minGap) {
        following.start = turn.start;
        changed = true;
        continue;
      }
      if (
        previous &&
        previous.speaker === turn.speaker &&
        turn.start - previous.end <= minGap
      ) {
        previous.end = turn.end;
        changed = true;
        continue;
      }
      next.push(turn);
    }
    current = next;
  }
  return current.filter(
    (turn) => turn.end - turn.start >= minTurn || current.length === 1,
  );
}

/** @param {number} value */
function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Display label for a 1-based speaker id, matching the transcript-processing
 * core ("Speaker A" for id 1).
 * @param {number} id
 */
export function speakerLabelForId(id) {
  return `Speaker ${String.fromCharCode(64 + id)}`;
}
