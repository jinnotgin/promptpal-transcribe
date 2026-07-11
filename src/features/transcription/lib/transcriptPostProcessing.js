import {
  constructSentences,
  initTranscriptProcessingCore,
  prepareWords,
} from "./transcriptProcessingCore.js";

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
  const constructed = constructSentences(
    prepared,
    options.diarizationLabels || [],
    options.skipDiarize ?? true,
  );
  const normalized = normalizeConstructedSegments(constructed);
  return normalized.length ? normalized : segments;
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
    .filter(Boolean);
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
  const words = segment.text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const duration = Math.max(0.01, segment.end - segment.start);
  const step = duration / words.length;
  return words.map((word, index) => ({
    text: word,
    start: segment.start + index * step,
    end: segment.start + (index + 1) * step,
  }));
}
