/**
 * Groups timestamped ASR words into transcript segments: a new segment
 * starts after 16 words, a pause over 0.9 s, or 8 s of speech. Word text is
 * joined script-aware, so Chinese and Japanese characters get no spaces.
 */

import { joinWordTexts } from "./wordText.js";

/**
 * @param {Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }>} words
 * @param {string} fallbackText
 * @param {number} chunkStart
 * @param {number} chunkDuration
 */
export function wordsToSegments(
  words,
  fallbackText,
  chunkStart,
  chunkDuration,
) {
  if (!words.length) {
    const text = fallbackText.replace(/\s+/g, " ").trim();
    return text
      ? [
          {
            text,
            start: roundTime(chunkStart),
            end: roundTime(chunkStart + chunkDuration),
            words: [],
          },
        ]
      : [];
  }

  const segments = [];
  let current = null;
  for (const word of words) {
    const shouldStartNew =
      !current ||
      current.words.length >= 16 ||
      word.start - current.end > 0.9 ||
      word.end - current.start > 8;
    if (shouldStartNew) {
      if (current) segments.push(finalizeSegment(current));
      current = { words: [word], start: word.start, end: word.end };
    } else {
      current.words.push(word);
      current.end = word.end;
    }
  }
  if (current) segments.push(finalizeSegment(current));
  return segments;
}

/**
 * @param {{ words: Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }>, start: number, end: number }} segment
 */
function finalizeSegment(segment) {
  return {
    text: joinWordTexts(segment.words.map((word) => word.text)),
    start: roundTime(segment.start),
    end: roundTime(segment.end),
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
 * @param {number} value
 */
function roundTime(value) {
  return Math.round(value * 100) / 100;
}
