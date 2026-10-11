/**
 * SenseVoice-Small CTC output to timestamped words, matching sherpa-onnx's
 * greedy search and ConvertSenseVoiceResult.
 *
 * The model prepends four prompt frames (language, emotion, event, text
 * normalisation), so the first four emitted tokens are those tags and audio
 * frame k is model frame k + 4. Each model frame covers 60 ms (10 ms fbank
 * shift x LFR shift of 6). CTC spikes mark token onsets only, so a word ends
 * where the next one starts, capped shortly after its last token so pauses
 * are not absorbed into the word.
 */

import { isUnspacedScript, joinWordTexts } from "./wordText.js";

export const SENSEVOICE_BLANK_ID = 0;
export const SENSEVOICE_PROMPT_FRAMES = 4;
export const SENSEVOICE_FRAME_SECONDS = 0.06;
const MAX_WORD_TAIL_SECONDS = 0.4;
const TAG = /^<\|(.*)\|>$/;
const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

/**
 * @typedef {{ text: string, start: number, end: number }} SenseVoiceWord
 * @typedef {{
 *   language: string | null,
 *   emotion: string | null,
 *   event: string | null,
 *   text: string,
 *   words: SenseVoiceWord[],
 * }} SenseVoiceResult
 */

/**
 * Parses sherpa-onnx `tokens.txt` ("<symbol> <id>" per line).
 * @param {string} text
 * @returns {string[]}
 */
export function parseTokens(text) {
  /** @type {string[]} */
  const symbols = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    const split = trimmed.lastIndexOf(" ");
    if (split <= 0) continue;
    const id = Number(trimmed.slice(split + 1));
    if (Number.isInteger(id)) symbols[id] = trimmed.slice(0, split);
  }
  return symbols;
}

/**
 * @param {Float32Array} logits frame-major [frames, vocabSize]
 * @param {number} frames
 * @param {number} vocabSize
 * @param {number} [blankId]
 * @returns {{ ids: number[], frames: number[] }}
 */
export function ctcGreedyDecode(
  logits,
  frames,
  vocabSize,
  blankId = SENSEVOICE_BLANK_ID,
) {
  /** @type {number[]} */
  const ids = [];
  /** @type {number[]} */
  const tokenFrames = [];
  let previous = -1;
  for (let t = 0; t < frames; t += 1) {
    const offset = t * vocabSize;
    let best = 0;
    let bestValue = logits[offset];
    for (let v = 1; v < vocabSize; v += 1) {
      if (logits[offset + v] > bestValue) {
        bestValue = logits[offset + v];
        best = v;
      }
    }
    if (best !== blankId && best !== previous) {
      ids.push(best);
      tokenFrames.push(t);
    }
    previous = best;
  }
  return { ids, frames: tokenFrames };
}

/**
 * @param {{ ids: number[], frames: number[] }} decoded
 * @param {string[]} symbols
 * @param {{ offsetSeconds: number, durationSeconds: number }} timing
 * @returns {SenseVoiceResult}
 */
export function decodeSenseVoiceTokens(decoded, symbols, timing) {
  /** @type {(string | null)[]} */
  const tags = [];
  /** @type {Array<{ text: string, start: number, last: number }>} */
  const pending = [];
  let previousText = "";

  decoded.ids.forEach((id, index) => {
    const symbol = symbols[id] ?? "";
    const tag = TAG.exec(symbol);
    if (tag) {
      if (index < SENSEVOICE_PROMPT_FRAMES) tags[index] = tag[1];
      return;
    }
    let piece = symbol.replaceAll("▁", " ");
    if (!piece.trim()) {
      // A bare ▁ token: the next piece starts a new word.
      previousText = " ";
      return;
    }
    if (previousText === " ") piece = ` ${piece.trimStart()}`;
    const time =
      timing.offsetSeconds +
      (decoded.frames[index] - SENSEVOICE_PROMPT_FRAMES) *
        SENSEVOICE_FRAME_SECONDS;
    const current = pending.at(-1);
    if (current && continuesWord(previousText, piece)) {
      current.text += piece;
      current.last = time;
    } else {
      pending.push({ text: piece.trim(), start: time, last: time });
    }
    previousText = piece;
  });

  const chunkEnd = timing.offsetSeconds + timing.durationSeconds;
  const words = pending.map((word, index) => {
    const next = pending[index + 1];
    const tailEnd = Math.min(word.last + MAX_WORD_TAIL_SECONDS, chunkEnd);
    const end = next ? Math.min(next.start, tailEnd) : tailEnd;
    return {
      text: word.text.trim(),
      start: roundTime(Math.max(timing.offsetSeconds, word.start)),
      end: roundTime(Math.max(word.start + SENSEVOICE_FRAME_SECONDS, end)),
    };
  });

  return {
    language: tags[0] ?? null,
    emotion: tags[1] ?? null,
    event: tags[2] ?? null,
    text: joinWordTexts(words.map((word) => word.text)),
    words,
  };
}

/**
 * A token extends the current word unless it starts a new ▁-prefixed piece,
 * is a Chinese/Japanese character, or follows one. Punctuation always
 * attaches to the word before it.
 * @param {string} previous
 * @param {string} piece
 */
function continuesWord(previous, piece) {
  if (PUNCTUATION_ONLY.test(piece.trim())) return true;
  if (piece.startsWith(" ")) return false;
  const first = Array.from(piece)[0] ?? "";
  const last = Array.from(previous).at(-1) ?? "";
  return !isUnspacedScript(first) && !isUnspacedScript(last);
}

/**
 * @param {number} value
 */
function roundTime(value) {
  return Math.round(value * 100) / 100;
}
