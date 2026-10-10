/**
 * Plans the audio regions Qwen3-ASR transcribes in one pipeline window.
 *
 * Qwen returns text without word timestamps, so speaker changes must happen
 * at region boundaries: regions are cut at diarization turns before ASR. Each
 * region stays under 30 s (split at the quietest nearby point) and is clipped
 * to the window's committed range so overlap audio is transcribed once.
 */

const SAMPLE_RATE = 16000;
const DEFAULT_MAX_SECONDS = 30;
const DEFAULT_PADDING = 0.25;
const MERGE_GAP = 0.5;
const MIN_REGION = 0.3;
const MAX_UNLABELLED_ABSORB = 1.5;
const SPLIT_SEARCH_SECONDS = 6;
const ENERGY_FRAME = 0.05;

/**
 * @typedef {{ start: number, end: number, speakerId: number | null }} QwenRegion
 */

/**
 * @param {{
 *   pcm: Float32Array,
 *   regions: Array<{ start: number, end: number }>,
 *   offset: number,
 *   commitStart: number,
 *   commitEnd: number,
 *   turns?: Array<{ id: number, start: number, end: number }> | null,
 *   maxSeconds?: number,
 *   padding?: number,
 * }} options regions are relative to `pcm`; turns and results are absolute
 * @returns {QwenRegion[]}
 */
export function planQwenRegions({
  pcm,
  regions,
  offset,
  commitStart,
  commitEnd,
  turns = null,
  maxSeconds = DEFAULT_MAX_SECONDS,
  padding = DEFAULT_PADDING,
}) {
  const windowEnd = Math.min(commitEnd, offset + pcm.length / SAMPLE_RATE);
  const speech = mergeSpans(
    regions
      .map((region) => ({
        start: Math.max(commitStart, offset + region.start - padding),
        end: Math.min(windowEnd, offset + region.end + padding),
      }))
      .filter((span) => span.end - span.start > 0),
    MERGE_GAP,
  );

  /** @type {QwenRegion[]} */
  let planned = [];
  for (const span of speech) {
    planned.push(
      ...(turns?.length
        ? labelBySpeaker(span, turns)
        : [{ ...span, speakerId: null }]),
    );
  }
  planned = mergeSameSpeaker(planned, maxSeconds);
  planned = planned.flatMap((region) =>
    splitLong(region, pcm, offset, maxSeconds),
  );
  return planned
    .filter((region) => region.end - region.start >= MIN_REGION)
    .map((region) => ({
      ...region,
      start: round(region.start),
      end: round(region.end),
    }));
}

/**
 * @param {Array<{ start: number, end: number }>} spans
 * @param {number} gap
 */
function mergeSpans(spans, gap) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  /** @type {Array<{ start: number, end: number }>} */
  const merged = [];
  for (const span of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && span.start - previous.end <= gap)
      previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Cut a speech span at speaker-turn boundaries, labelling each piece with the
 * speaker covering most of it; short unlabelled pieces join a neighbour.
 * @param {{ start: number, end: number }} span
 * @param {Array<{ id: number, start: number, end: number }>} turns
 * @returns {QwenRegion[]}
 */
function labelBySpeaker(span, turns) {
  const cuts = new Set([span.start, span.end]);
  for (const turn of turns) {
    if (turn.start > span.start && turn.start < span.end) cuts.add(turn.start);
    if (turn.end > span.start && turn.end < span.end) cuts.add(turn.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  /** @type {QwenRegion[]} */
  const pieces = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    let speakerId = null;
    let bestOverlap = 0;
    for (const turn of turns) {
      const overlap = Math.min(end, turn.end) - Math.max(start, turn.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        speakerId = turn.id;
      }
    }
    const previous = pieces[pieces.length - 1];
    if (previous && previous.speakerId === speakerId) previous.end = end;
    else pieces.push({ start, end, speakerId });
  }

  // Unlabelled slivers are usually padding or a turn edge: give them to a
  // neighbour instead of transcribing them alone.
  /** @type {QwenRegion[]} */
  const absorbed = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (
      piece.speakerId === null &&
      piece.end - piece.start <= MAX_UNLABELLED_ABSORB
    ) {
      const previous = absorbed[absorbed.length - 1];
      const next = pieces[index + 1];
      if (previous) {
        previous.end = piece.end;
        continue;
      }
      if (next) {
        next.start = piece.start;
        continue;
      }
    }
    const previous = absorbed[absorbed.length - 1];
    if (previous && previous.speakerId === piece.speakerId)
      previous.end = piece.end;
    else absorbed.push({ ...piece });
  }
  return absorbed;
}

/**
 * @param {QwenRegion[]} regions
 * @param {number} maxSeconds
 */
function mergeSameSpeaker(regions, maxSeconds) {
  /** @type {QwenRegion[]} */
  const merged = [];
  for (const region of regions) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.speakerId === region.speakerId &&
      region.start - previous.end <= MERGE_GAP &&
      region.end - previous.start <= maxSeconds
    ) {
      previous.end = region.end;
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/**
 * @param {QwenRegion} region
 * @param {Float32Array} pcm
 * @param {number} offset
 * @param {number} maxSeconds
 * @returns {QwenRegion[]}
 */
function splitLong(region, pcm, offset, maxSeconds) {
  /** @type {QwenRegion[]} */
  const out = [];
  let start = region.start;
  while (region.end - start > maxSeconds) {
    const searchEnd = start + maxSeconds;
    const searchStart = Math.max(
      start + maxSeconds / 2,
      searchEnd - SPLIT_SEARCH_SECONDS,
    );
    const cut = quietestPoint(pcm, offset, searchStart, searchEnd);
    out.push({ start, end: cut, speakerId: region.speakerId });
    start = cut;
  }
  out.push({ start, end: region.end, speakerId: region.speakerId });
  return out;
}

/**
 * Start time of the lowest-energy 50 ms frame in [from, to).
 * @param {Float32Array} pcm
 * @param {number} offset
 * @param {number} from
 * @param {number} to
 */
function quietestPoint(pcm, offset, from, to) {
  const frame = Math.round(ENERGY_FRAME * SAMPLE_RATE);
  let best = to;
  let bestEnergy = Infinity;
  for (let time = from; time + ENERGY_FRAME <= to; time += ENERGY_FRAME) {
    const begin = Math.round((time - offset) * SAMPLE_RATE);
    let energy = 0;
    for (
      let index = begin;
      index < begin + frame && index < pcm.length;
      index += 1
    ) {
      energy += pcm[index] * pcm[index];
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = time;
    }
  }
  return best;
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1000) / 1000;
}
