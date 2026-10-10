/**
 * Turns Qwen3-ASR text (no word timestamps) into transcript segments.
 *
 * Text is split into sentences and timed in proportion to its length. Words
 * are display units for playback highlighting: Latin-script words stay
 * separate, while CJK runs become phrases ending at punctuation so they are
 * never joined with English-style spaces.
 */

/**
 * @typedef {import('./transcriptionDb.js').TranscriptSegment} TranscriptSegment
 */

const SENTENCE_END = /[。！？!?；;]|\.(?=\s|$)/;
const PHRASE_END = /[，,、：:。！？!?；;]/;
const CJK = /[　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/;
const MAX_PHRASE_CHARS = 12;

/**
 * @param {string} text
 * @param {{ start: number, end: number, speaker: string | null }} span
 * @returns {Omit<TranscriptSegment, 'id'>[]}
 */
export function buildTimedSegments(text, { start, end, speaker }) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = splitSentences(clean);
  const units = sentences.map(splitDisplayUnits);
  const weights = units.map((list) =>
    list.reduce((sum, unit) => sum + weightOf(unit), 0),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const duration = Math.max(0, end - start);

  let cursor = start;
  return sentences.map((sentence, index) => {
    const sentenceStart = cursor;
    const sentenceEnd =
      index === sentences.length - 1
        ? end
        : cursor + (duration * weights[index]) / total;
    cursor = sentenceEnd;
    let wordCursor = sentenceStart;
    const sentenceWeight = weights[index] || 1;
    const words = units[index].map((unit, unitIndex, list) => {
      const wordStart = wordCursor;
      const wordEnd =
        unitIndex === list.length - 1
          ? sentenceEnd
          : wordCursor +
            ((sentenceEnd - sentenceStart) * weightOf(unit)) / sentenceWeight;
      wordCursor = wordEnd;
      return { text: unit, start: round(wordStart), end: round(wordEnd) };
    });
    return {
      text: sentence,
      start: round(sentenceStart),
      end: round(sentenceEnd),
      speaker,
      words,
    };
  });
}

/**
 * Join display units, adding a space only between two Latin-script pieces.
 * @param {string[]} pieces
 */
export function joinTranscriptText(pieces) {
  let out = "";
  for (const piece of pieces) {
    if (!piece) continue;
    const previous = out.at(-1) || "";
    const needsSpace =
      out && !CJK.test(previous) && !CJK.test(piece[0]) && !/\s/.test(previous);
    out += needsSpace ? ` ${piece}` : piece;
  }
  return out;
}

/** @param {string} text */
function splitSentences(text) {
  const sentences = [];
  let current = "";
  for (const char of text) {
    current += char;
    if (
      SENTENCE_END.test(char) &&
      !(char === "." && /\d$/.test(current.slice(0, -1)))
    ) {
      sentences.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences.filter(Boolean);
}

/**
 * @param {string} sentence
 * @returns {string[]}
 */
function splitDisplayUnits(sentence) {
  if (!CJK.test(sentence)) return sentence.split(" ").filter(Boolean);
  const units = [];
  let current = "";
  let cjkChars = 0;
  for (const char of sentence) {
    if (char === " " && !CJK.test(current.at(-1) || "")) {
      current += char;
      continue;
    }
    current += char;
    if (CJK.test(char)) cjkChars += 1;
    if (PHRASE_END.test(char) || cjkChars >= MAX_PHRASE_CHARS) {
      units.push(current.trim());
      current = "";
      cjkChars = 0;
    }
  }
  if (current.trim()) units.push(current.trim());
  return units;
}

/**
 * Approximate spoken length: one unit per CJK character, ~one per three
 * Latin letters.
 * @param {string} unit
 */
function weightOf(unit) {
  let weight = 0;
  for (const char of unit) {
    if (CJK.test(char)) weight += 1;
    else if (/\p{L}|\p{N}/u.test(char)) weight += 1 / 3;
  }
  return Math.max(weight, 0.5);
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
