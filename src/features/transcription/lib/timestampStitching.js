/**
 * Cross-chunk timestamp alignment and deduplication.
 *
 * When chunks overlap, the same word/phrase may appear in adjacent chunks.
 * This module keeps the candidate rows, then rebuilds the transcript from
 * word timings so boundary words are preserved and near-identical duplicate
 * emissions are removed.
 */

/** @typedef {import('./transcriptionDb.js').TranscriptSegment} TranscriptSegment */
/** @typedef {import('./chunkingStrategy.js').AsrChunk} AsrChunk */

/**
 * Stitch segments from multiple chunks into a single timeline.
 *
 * @param {Array<{ chunk: AsrChunk, segments: TranscriptSegment[] }>} chunkResults
 * @returns {TranscriptSegment[]}
 */
export function stitchSegments(chunkResults) {
  if (chunkResults.length === 0) return [];
  if (chunkResults.length === 1) return chunkResults[0].segments;

  /** @type {TranscriptSegment[]} */
  const stitched = [];

  for (let i = 0; i < chunkResults.length; i++) {
    const { segments } = chunkResults[i];

    for (const seg of segments) {
      // Deduplicate: skip if previous segment already covers this time
      const last = stitched[stitched.length - 1];
      if (last && seg.start < last.end && seg.text === last.text) {
        continue;
      }

      stitched.push(seg);
    }
  }

  return stitched;
}

/**
 * Rebuild readable transcript rows from word timings after stitching.
 * This preserves overlap boundary words while removing near-identical
 * duplicate emissions produced by padded/overlapping chunks.
 *
 * @param {TranscriptSegment[]} segments
 * @returns {TranscriptSegment[]}
 */
export function rebuildSegmentsFromWords(segments) {
  const words = collectWords(segments);
  if (!words.length) return dedupeSegments(segments);

  words.sort((a, b) => a.start - b.start || a.end - b.end);
  const cleanedWords = dedupeWords(words);
  if (!cleanedWords.length) return [];

  /** @type {TranscriptSegment[]} */
  const rebuilt = [];
  let current = null;

  for (const word of cleanedWords) {
    const shouldStartNew =
      !current ||
      current.words.length >= 28 ||
      word.start - current.end > 1.25 ||
      word.end - current.start > 12 ||
      /[.!?]$/.test(current.words[current.words.length - 1]?.text || "");

    if (shouldStartNew) {
      if (current) rebuilt.push(finalizeWordsSegment(current, rebuilt.length));
      current = {
        words: [word],
        start: word.start,
        end: word.end,
        speaker: word.speaker ?? null,
      };
    } else {
      current.words.push(word);
      current.end = Math.max(current.end, word.end);
    }
  }

  if (current) rebuilt.push(finalizeWordsSegment(current, rebuilt.length));
  return rebuilt;
}

/**
 * Merge adjacent segments with the same speaker into longer segments.
 * Useful for producing cleaner transcript output.
 *
 * @param {TranscriptSegment[]} segments
 * @param {number} [maxGap=1.0] - Maximum gap in seconds to merge across
 * @returns {TranscriptSegment[]}
 */
export function mergeAdjacentSegments(segments, maxGap = 1.0) {
  if (segments.length === 0) return [];

  /** @type {TranscriptSegment[]} */
  const merged = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = segments[i];

    const sameSpeaker =
      prev.speaker === curr.speaker ||
      (prev.speaker === null && curr.speaker === null);
    const smallGap = curr.start - prev.end <= maxGap;

    if (sameSpeaker && smallGap) {
      prev.end = curr.end;
      prev.text = prev.text + " " + curr.text;
      prev.words = [
        ...(prev.words || fallbackWords(prev)),
        ...(curr.words || fallbackWords(curr)),
      ];
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

/**
 * @param {TranscriptSegment} segment
 * @returns {NonNullable<TranscriptSegment['words']>}
 */
function fallbackWords(segment) {
  const words = segment.text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const duration = Math.max(0.01, segment.end - segment.start);
  const step = duration / words.length;
  return words.map((word, index) => ({
    text: word,
    start: segment.start + index * step,
    end: segment.start + (index + 1) * step,
    speaker: segment.speaker ?? null,
  }));
}

/**
 * @param {TranscriptSegment[]} segments
 */
function collectWords(segments) {
  const words = [];
  for (const segment of segments) {
    const segmentWords = segment.words?.length
      ? segment.words
      : fallbackWords(segment);
    for (const word of segmentWords) {
      const text = normalizeDisplayWord(word.text);
      const start = Number(word.start);
      const end = Number(word.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      words.push({
        text,
        start,
        end: Math.max(start, end),
        speaker: segment.speaker ?? null,
        confidence: Number.isFinite(Number(word.confidence))
          ? Number(word.confidence)
          : undefined,
        utteranceId: Number.isFinite(Number(word.utteranceId))
          ? Number(word.utteranceId)
          : undefined,
      });
    }
  }
  return words;
}

/**
 * @param {Array<{ text: string, start: number, end: number, speaker: string | null, confidence?: number, utteranceId?: number }>} words
 */
function dedupeWords(words) {
  const cleaned = [];
  for (const word of words) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && isNearDuplicateWord(previous, word)) {
      if (word.end - word.start > previous.end - previous.start) {
        cleaned[cleaned.length - 1] = word;
      }
      continue;
    }
    cleaned.push(word);
  }
  return cleaned;
}

/**
 * @param {{ text: string, start: number, end: number }} previous
 * @param {{ text: string, start: number, end: number }} current
 */
function isNearDuplicateWord(previous, current) {
  if (normalizeWord(previous.text) !== normalizeWord(current.text))
    return false;
  const startDelta = Math.abs(current.start - previous.start);
  const overlap =
    Math.min(previous.end, current.end) -
    Math.max(previous.start, current.start);
  const previousDuration = Math.max(0.01, previous.end - previous.start);
  const currentDuration = Math.max(0.01, current.end - current.start);
  const overlapRatio =
    overlap > 0 ? overlap / Math.min(previousDuration, currentDuration) : 0;
  return startDelta <= 0.25 || overlapRatio >= 0.5;
}

/**
 * @param {{ words: Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number, speaker?: string | null }>, start: number, end: number, speaker: string | null }} segment
 * @param {number} index
 * @returns {TranscriptSegment}
 */
function finalizeWordsSegment(segment, index) {
  return {
    id: `asr-row-${index}-${Math.round(segment.start * 1000)}`,
    start: roundTime(segment.start),
    end: roundTime(segment.end),
    text: segment.words.map((word) => word.text).join(" "),
    speaker: segment.speaker,
    words: segment.words.map((word) => ({
      text: word.text,
      start: roundTime(word.start),
      end: roundTime(word.end),
      confidence: word.confidence,
      utteranceId: word.utteranceId,
    })),
  };
}

/**
 * @param {TranscriptSegment[]} segments
 */
function dedupeSegments(segments) {
  const deduped = [];
  for (const segment of segments) {
    const previous = deduped[deduped.length - 1];
    if (
      previous &&
      normalizeText(previous.text) === normalizeText(segment.text) &&
      Math.abs(previous.start - segment.start) <= 0.5
    ) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    deduped.push({ ...segment });
  }
  return deduped;
}

/**
 * @param {string} text
 */
function normalizeDisplayWord(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} text
 */
function normalizeWord(text) {
  return normalizeDisplayWord(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * @param {string} text
 */
function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * @param {number} value
 */
function roundTime(value) {
  return Math.round(value * 100) / 100;
}
