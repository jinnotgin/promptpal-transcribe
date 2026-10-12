/**
 * Cross-chunk timestamp alignment and deduplication.
 *
 * When chunks overlap, the same word/phrase may appear in adjacent chunks.
 * This module keeps the candidate rows, then rebuilds the transcript from
 * word timings so boundary words are preserved and near-identical duplicate
 * emissions are removed.
 */

import { endsSentence, joinWordTexts, splitTextIntoWords } from "./wordText.js";

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

  let stitched = chunkResults[0].segments;
  for (let i = 1; i < chunkResults.length; i++) {
    const { chunk, segments } = chunkResults[i];
    stitched = joinAtSeam(stitched, segments, {
      start: chunk.start,
      end: chunkResults[i - 1].chunk.end,
    });
  }
  return stitched;
}

/**
 * Join two transcription passes whose audio overlaps in `overlap` at one
 * seam: words before it come from `earlier`, words after it from `later`.
 * Merging both passes word by word would interleave their utterance ids,
 * and the sentence builder starts a new row at every id change.
 *
 * The seam sits in the pause nearest the middle of the overlap, where both
 * passes had audio context on either side, so no word is cut in half.
 *
 * @param {TranscriptSegment[]} earlier
 * @param {TranscriptSegment[]} later
 * @param {{ start: number, end: number }} overlap
 * @returns {TranscriptSegment[]}
 */
export function joinAtSeam(earlier, later, overlap) {
  if (!(overlap.end > overlap.start)) return [...earlier, ...later];
  const earlierSpans = spansWithin(earlier, overlap);
  const laterSpans = spansWithin(later, overlap);
  // A pass that heard nothing in the overlap yields it to the other pass.
  const seam = !earlierSpans.length
    ? overlap.start
    : !laterSpans.length
      ? overlap.end
      : findSeam([...earlierSpans, ...laterSpans], overlap);
  return [
    ...earlier.flatMap((segment) =>
      keepWords(segment, (middle) => middle < seam),
    ),
    ...later.flatMap((segment) =>
      keepWords(segment, (middle) => middle >= seam),
    ),
  ];
}

/**
 * Word (or untimed row) time spans that touch the overlap.
 * @param {TranscriptSegment[]} segments
 * @param {{ start: number, end: number }} overlap
 */
function spansWithin(segments, overlap) {
  return segments
    .flatMap(
      (segment) =>
        /** @type {Array<{ start: number, end: number }>} */ (
          segment.words?.length ? segment.words : [segment]
        ),
    )
    .map((span) => ({ start: Number(span.start), end: Number(span.end) }))
    .filter((span) => span.end > overlap.start && span.start < overlap.end);
}

/**
 * @param {Array<{ start: number, end: number }>} spans
 * @param {{ start: number, end: number }} overlap
 */
function findSeam(spans, overlap) {
  const middle = (overlap.start + overlap.end) / 2;
  spans.sort((a, b) => a.start - b.start);

  // Without a pause, fall back to the middle and let word dedupe tidy up.
  let seam = middle;
  let distance = Infinity;
  /**
   * @param {number} from
   * @param {number} to
   */
  const considerPause = (from, to) => {
    if (to <= from) return;
    const point = Math.min(Math.max(middle, from), to);
    if (Math.abs(point - middle) < distance) {
      seam = point;
      distance = Math.abs(point - middle);
    }
  };
  let cursor = overlap.start;
  for (const span of spans) {
    considerPause(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  considerPause(cursor, overlap.end);
  return seam;
}

/**
 * @param {TranscriptSegment} segment
 * @param {(middle: number) => boolean} keep
 * @returns {TranscriptSegment[]}
 */
function keepWords(segment, keep) {
  if (!segment.words?.length) {
    return keep((segment.start + segment.end) / 2) ? [segment] : [];
  }
  const words = segment.words.filter((word) =>
    keep((word.start + word.end) / 2),
  );
  if (words.length === segment.words.length) return [segment];
  if (!words.length) return [];
  return [
    {
      ...segment,
      text: joinWordTexts(words.map((word) => word.text)),
      start: words[0].start,
      end: words[words.length - 1].end,
      words,
    },
  ];
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
      endsSentence(current.words[current.words.length - 1]?.text || "");

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
      // Derive fallback words before prev's text and end change.
      prev.words = [
        ...(prev.words || fallbackWords(prev)),
        ...(curr.words || fallbackWords(curr)),
      ];
      prev.end = curr.end;
      prev.text = joinWordTexts([prev.text, curr.text]);
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
  const words = splitTextIntoWords(segment.text);
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
 * @param {{ text: string, start: number, end: number, utteranceId?: number }} previous
 * @param {{ text: string, start: number, end: number, utteranceId?: number }} current
 */
function isNearDuplicateWord(previous, current) {
  if (normalizeWord(previous.text) !== normalizeWord(current.text))
    return false;
  // Overlap duplicates come from different chunks; repeats within one chunk
  // are real speech (谢谢, "very very").
  if (
    previous.utteranceId != null &&
    previous.utteranceId === current.utteranceId
  )
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
    text: joinWordTexts(segment.words.map((word) => word.text)),
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
