import {
  constructSentences,
  initTranscriptProcessingCore,
  prepareWords,
} from "./transcriptProcessingCore.js";
import {
  isUnspacedScript,
  joinWordTexts,
  splitTextIntoWords,
} from "./wordText.js";

const UNSPACED_SENTENCE_END = /[。！？]["”」』)]?$/u;

/**
 * @typedef {import('./transcriptionDb.js').TranscriptSegment} TranscriptSegment
 */

/**
 * @param {TranscriptSegment[]} segments
 * @param {{ diarizationLabels?: unknown, skipDiarize?: boolean }} [options]
 * @returns {Promise<TranscriptSegment[]>}
 */
export async function constructTranscriptSegments(segments, options = {}) {
  const words = flattenSegmentWords(segments);
  if (!words.length) return segments;

  await initTranscriptProcessingCore();
  const prepared = prepareWords(words);
  const skipDiarize = options.skipDiarize ?? true;
  const constructed = constructSentences(
    prepared,
    options.diarizationLabels || [],
    skipDiarize,
  );
  const normalized = normalizeConstructedSegments(constructed);
  const result = normalized.length ? normalized : segments;
  return skipDiarize
    ? result.map((segment) => ({ ...segment, speaker: null }))
    : result;
}

/**
 * @param {TranscriptSegment[]} segments
 */
export function flattenSegmentWords(segments) {
  const words = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const sourceWords = segment.words?.length
      ? segment.words
      : fallbackWords(segment);
    for (const word of sourceWords) {
      const rawWord =
        /** @type {{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }} */ (
          word
        );
      const text = String(rawWord.text || "").trim();
      const start = Number(rawWord.start);
      const end = Number(rawWord.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      words.push({
        text,
        start,
        end: Math.max(start, end),
        confidence: Number.isFinite(rawWord.confidence)
          ? rawWord.confidence
          : undefined,
        utteranceId: Number.isFinite(rawWord.utteranceId)
          ? rawWord.utteranceId
          : segmentIndex,
      });
    }
  }
  return words;
}

/**
 * @param {unknown} constructed
 * @returns {TranscriptSegment[]}
 */
export function normalizeConstructedSegments(constructed) {
  const object =
    /** @type {{ results?: unknown[], segments?: unknown[] } | null} */ (
      constructed && typeof constructed === "object" ? constructed : null
    );
  const source = Array.isArray(constructed)
    ? constructed
    : Array.isArray(object?.results)
      ? object.results
      : Array.isArray(object?.segments)
        ? object.segments
        : [];

  return source
    .map((segment, index) => normalizeConstructedSegment(segment, index))
    .filter(Boolean)
    .flatMap((segment) => splitUnspacedSentences(segment));
}

/**
 * The WASM sentence builder joins words with spaces and only ends sentences
 * on Latin punctuation. For rows with Chinese or Japanese words, rebuild the
 * text script-aware and split after 。！？. Latin-only rows are kept as built.
 * @param {TranscriptSegment} segment
 * @returns {TranscriptSegment[]}
 */
function splitUnspacedSentences(segment) {
  const words = segment.words;
  if (!words?.length) return [segment];
  if (!words.some((word) => Array.from(word.text).some(isUnspacedScript))) {
    return [segment];
  }
  /** @type {Array<NonNullable<TranscriptSegment['words']>>} */
  const sentences = [[]];
  words.forEach((word, index) => {
    sentences[sentences.length - 1].push(word);
    if (UNSPACED_SENTENCE_END.test(word.text) && index < words.length - 1) {
      sentences.push([]);
    }
  });
  if (sentences.length === 1) {
    return [
      { ...segment, text: joinWordTexts(words.map((word) => word.text)) },
    ];
  }
  return sentences.map((sentenceWords, index) => ({
    ...segment,
    id: `${segment.id}-${index}`,
    text: joinWordTexts(sentenceWords.map((word) => word.text)),
    start: index === 0 ? segment.start : sentenceWords[0].start,
    end:
      index === sentences.length - 1
        ? segment.end
        : sentenceWords[sentenceWords.length - 1].end,
    words: sentenceWords,
  }));
}

/**
 * @param {unknown} rawSegment
 * @param {number} index
 * @returns {TranscriptSegment | null}
 */
function normalizeConstructedSegment(rawSegment, index) {
  if (!rawSegment || typeof rawSegment !== "object") return null;
  const segment = /** @type {Record<string, unknown>} */ (rawSegment);
  const text = String(segment.text || segment.sentence || "").trim();
  const start = readTime(segment, ["start", "startTime", "start_time"]);
  const end = readTime(segment, ["end", "endTime", "end_time"]);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const words = Array.isArray(segment.words)
    ? segment.words
        .map((word) => {
          const rawWord = /** @type {Record<string, unknown>} */ (word);
          return {
            text: String(rawWord.text || "").trim(),
            start: readTime(rawWord, ["start", "startTime", "start_time"]),
            end: readTime(rawWord, ["end", "endTime", "end_time"]),
            confidence: Number.isFinite(Number(rawWord.confidence))
              ? Number(rawWord.confidence)
              : undefined,
            utteranceId: Number.isFinite(Number(rawWord.utteranceId))
              ? Number(rawWord.utteranceId)
              : undefined,
          };
        })
        .filter(
          (word) =>
            word.text &&
            Number.isFinite(word.start) &&
            Number.isFinite(word.end),
        )
    : undefined;

  return {
    id: String(
      segment.id || `transcript-row-${index}-${Math.round(start * 1000)}`,
    ),
    text,
    start,
    end: Math.max(start, end),
    speaker: normalizeSpeaker(segment.speaker),
    ...(words?.length ? { words } : {}),
  };
}

/**
 * @param {Record<string, unknown>} object
 * @param {string[]} keys
 */
function readTime(object, keys) {
  for (const key of keys) {
    const value = Number(object[key]);
    if (Number.isFinite(value)) return Math.round(value * 100) / 100;
  }
  return NaN;
}

/**
 * @param {unknown} speaker
 */
function normalizeSpeaker(speaker) {
  if (speaker == null || speaker === "") return null;
  const label = String(speaker);
  if (/^speaker\s+/i.test(label)) return label;
  if (/^[A-Z]$/.test(label)) return `Speaker ${label}`;
  if (/^\d+$/.test(label)) return `Speaker ${Number(label) + 1}`;
  return label;
}

/**
 * @param {TranscriptSegment} segment
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
  }));
}
