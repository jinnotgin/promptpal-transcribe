/**
 * Overlap-aware chunk splitting for ASR inference.
 *
 * Takes VAD speech regions and splits them into chunks that the ASR model
 * can process, with speech padding for boundary words and overlap for
 * cross-chunk continuity.
 */

/** @typedef {import('./vadSignal.js').SpeechRegion} SpeechRegion */
/** @typedef {{ start: number, end: number, regionIndex: number }} AsrChunk */
/** @typedef {{ audioDuration?: number, maxDuration?: number, padding?: number, overlap?: number }} ChunkOptions */

const MAX_CHUNK_DURATION = 90; // The reference pipeline uses 90s transcription chunks.
const CHUNK_PADDING = 3; // seconds of context around VAD speech regions
const CHUNK_OVERLAP = 3; // seconds of overlap between long chunks
const SAMPLE_RATE = 16000;

/**
 * Split speech regions into ASR-sized chunks.
 * Regions shorter than MAX_CHUNK_DURATION are kept as-is.
 * Longer regions are split with overlap.
 *
 * @param {SpeechRegion[]} regions
 * @param {ChunkOptions} [options]
 * @returns {AsrChunk[]}
 */
export function splitIntoChunks(regions, options = {}) {
  if (regions.length && regions.every((region) => region.preChunked === true)) {
    return regions.map((region, index) => ({
      start: region.start,
      end: region.end,
      regionIndex: index,
    }));
  }

  const maxDuration = options.maxDuration ?? MAX_CHUNK_DURATION;
  const padding = options.padding ?? CHUNK_PADDING;
  const overlap = options.overlap ?? CHUNK_OVERLAP;
  const audioDuration = Number.isFinite(options.audioDuration)
    ? Math.max(0, options.audioDuration)
    : null;

  /** @type {AsrChunk[]} */
  const chunks = [];
  const paddedRegions = padAndMergeRegions(regions, padding, audioDuration);

  for (let i = 0; i < paddedRegions.length; i++) {
    const region = paddedRegions[i];
    const duration = region.end - region.start;

    if (duration <= maxDuration) {
      chunks.push({
        start: region.start,
        end: region.end,
        regionIndex: i,
      });
    } else {
      // Split long region into overlapping chunks
      let chunkStart = region.start;
      while (chunkStart < region.end) {
        const chunkEnd = Math.min(chunkStart + maxDuration, region.end);
        chunks.push({
          start: chunkStart,
          end: chunkEnd,
          regionIndex: i,
        });
        // Advance by (max - overlap) so chunks overlap
        chunkStart += Math.max(1, maxDuration - overlap);
        // Avoid tiny trailing chunks
        if (region.end - chunkStart < 1.0) break;
      }
    }
  }

  return chunks;
}

/**
 * @param {SpeechRegion[]} regions
 * @param {number} padding
 * @param {number | null} audioDuration
 * @returns {SpeechRegion[]}
 */
function padAndMergeRegions(regions, padding, audioDuration) {
  const maxEnd = audioDuration ?? Infinity;
  const padded = regions
    .map((region) => ({
      start: Math.max(0, region.start - padding),
      end: Math.min(maxEnd, region.end + padding),
    }))
    .filter((region) => region.end > region.start)
    .sort((a, b) => a.start - b.start);

  /** @type {SpeechRegion[]} */
  const merged = [];
  for (const region of padded) {
    const previous = merged[merged.length - 1];
    if (previous && region.start <= previous.end) {
      previous.end = Math.max(previous.end, region.end);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/**
 * Extract a slice of PCM audio for a given chunk.
 * @param {Float32Array} pcm - Full 16kHz mono audio
 * @param {AsrChunk} chunk
 * @returns {Float32Array}
 */
export function extractChunkAudio(pcm, chunk) {
  const startSample = Math.round(chunk.start * SAMPLE_RATE);
  const endSample = Math.min(Math.round(chunk.end * SAMPLE_RATE), pcm.length);
  return pcm.slice(startSample, endSample);
}

/**
 * Chunk limits for SenseVoice. It is accurate on sentence-length input but
 * drops words past ~15 s and garbles Chinese/English switching past ~20 s,
 * so chunks follow VAD utterances: neighbours separated by short pauses are
 * grouped up to `targetDuration`, and continuous speech is cut at its
 * quietest point so no chunk exceeds `maxDuration`. Chunks never overlap.
 */
export const UTTERANCE_CHUNK_LIMITS = Object.freeze({
  targetDuration: 8,
  maxDuration: 12,
  minSplitDuration: 4,
  maxGap: 1,
  padding: 0.2,
});

const QUIET_WINDOW_SECONDS = 0.1;
const QUIET_HOP_SECONDS = 0.05;

/**
 * @param {SpeechRegion[]} speech raw VAD speech regions (not pre-chunked)
 * @param {Float32Array} pcm 16 kHz mono audio the regions refer to
 * @param {Partial<typeof UTTERANCE_CHUNK_LIMITS>} [options]
 * @returns {AsrChunk[]}
 */
export function splitIntoUtteranceChunks(speech, pcm, options = {}) {
  const limits = { ...UTTERANCE_CHUNK_LIMITS, ...options };
  const audioDuration = pcm.length / SAMPLE_RATE;
  const pieceCap = limits.maxDuration - 2 * limits.padding;

  /** @type {Array<{ start: number, end: number }>} */
  const pieces = [];
  const regions = speech
    .map((region) => ({
      start: Math.max(0, region.start),
      end: Math.min(audioDuration, region.end),
    }))
    .filter((region) => region.end > region.start)
    .sort((a, b) => a.start - b.start);
  for (const region of regions) {
    let start = region.start;
    while (region.end - start > pieceCap) {
      const cut = findQuietestPoint(
        pcm,
        start + limits.minSplitDuration,
        start + pieceCap,
      );
      pieces.push({ start, end: cut });
      start = cut;
    }
    pieces.push({ start, end: region.end });
  }

  /** @type {Array<{ start: number, end: number }>} */
  const groups = [];
  for (const piece of pieces) {
    const current = groups[groups.length - 1];
    if (
      current &&
      piece.start - current.end <= limits.maxGap &&
      piece.end - current.start <= limits.targetDuration
    ) {
      current.end = piece.end;
    } else {
      groups.push({ ...piece });
    }
  }

  /** @type {AsrChunk[]} */
  const chunks = [];
  groups.forEach((group, index) => {
    const previousEnd = chunks[chunks.length - 1]?.end ?? 0;
    const nextStart = groups[index + 1]?.start ?? audioDuration;
    chunks.push({
      start: Math.max(previousEnd, group.start - limits.padding),
      end: Math.min(nextStart, group.end + limits.padding),
      regionIndex: index,
    });
  });
  return chunks;
}

/**
 * Centre of the lowest-energy 100 ms window between `from` and `to`.
 * @param {Float32Array} pcm
 * @param {number} from seconds
 * @param {number} to seconds
 */
function findQuietestPoint(pcm, from, to) {
  const window = Math.round(QUIET_WINDOW_SECONDS * SAMPLE_RATE);
  const hop = Math.round(QUIET_HOP_SECONDS * SAMPLE_RATE);
  const first = Math.round(from * SAMPLE_RATE);
  const last = Math.round(to * SAMPLE_RATE) - window;
  let bestStart = Math.max(first, last);
  let bestEnergy = Infinity;
  for (let start = first; start <= last; start += hop) {
    let energy = 0;
    for (let i = start; i < start + window; i += 1) energy += pcm[i] * pcm[i];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }
  return (bestStart + window / 2) / SAMPLE_RATE;
}
