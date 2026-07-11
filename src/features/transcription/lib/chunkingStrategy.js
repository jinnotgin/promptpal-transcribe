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
