/**
 * Greedy Qwen3-ASR decoding, independent of the ONNX runtime.
 *
 * The worker supplies `model`: an audio encoder, an embedding lookup over the
 * int8 token table, a prefill pass that builds the KV cache, and a single-token
 * step that extends it.
 */

import { computeQwenAsrFeatures } from "./qwenAsrFeatures.js";
import {
  QWEN_ASR_EOS_IDS,
  QWEN_ASR_HEADER_KEYWORD_ID,
  QWEN_ASR_LANGUAGE_PREFIX_IDS,
  buildQwenAsrPrompt,
  parseQwenAsrOutput,
  qwenAudioTokenCount,
} from "./qwenAsrPrompt.js";

/**
 * @typedef {{
 *   hiddenSize: number,
 *   encode: (features: Float32Array, frames: number) => Promise<Float32Array>,
 *   embed: (ids: ArrayLike<number>) => Float32Array,
 *   prefill: (embeds: Float32Array, rows: number) => Promise<Float32Array>,
 *   step: (embed: Float32Array, position: number) => Promise<Float32Array>,
 *   reset: () => void,
 * }} QwenAsrModel
 * @typedef {'zh' | 'en' | 'yue'} QwenLanguage
 */

/** A repeating tail this many tokens long is a decoding loop, not speech. */
const LOOP_TOKENS = 16;
/** Longest repeating token pattern checked, e.g. "Okay." plus a space. */
const MAX_LOOP_PERIOD = 8;
/** Fewest pattern repeats that count as a loop, for long patterns. */
const MIN_LOOP_REPEATS = 4;

/**
 * Token budget: ~8 tokens/s covers fast Mandarin and English speech, with a
 * floor for the language header and a ceiling that stops runaway repeats.
 * @param {number} seconds
 */
export function qwenMaxNewTokens(seconds) {
  return Math.min(512, Math.max(64, Math.ceil(seconds * 8) + 64));
}

/**
 * @param {{
 *   pcm: Float32Array,
 *   model: QwenAsrModel,
 *   decoder: { decode: (ids: ArrayLike<number>) => string },
 *   language?: QwenLanguage | null,
 *   maxNewTokens?: number,
 * }} options `language` forces the whole header; leave it unset for
 *   code-switched speech so the model is never pushed to translate
 * @returns {Promise<{ text: string, language: string | null, tokens: number[], forcedLanguage: QwenLanguage | null, headerForced: boolean }>}
 */
export async function generateQwenTranscript({
  pcm,
  model,
  decoder,
  language = null,
  maxNewTokens,
}) {
  const { features, frames } = computeQwenAsrFeatures(pcm);
  if (!frames)
    return {
      text: "",
      language: null,
      tokens: [],
      forcedLanguage: null,
      headerForced: false,
    };
  const audio = await model.encode(features, frames);
  const audioTokens = audio.length / model.hiddenSize;
  if (audioTokens !== qwenAudioTokenCount(frames)) {
    throw new Error(
      `Qwen3-ASR encoder returned ${audioTokens} tokens, expected ${qwenAudioTokenCount(frames)}`,
    );
  }
  const budget = maxNewTokens ?? qwenMaxNewTokens(pcm.length / 16000);

  if (language) {
    const forced = await decode(QWEN_ASR_LANGUAGE_PREFIX_IDS[language]);
    return { ...forced, forcedLanguage: language, headerForced: true };
  }
  const first = await decode([]);
  // Headerless text is still a transcript (as in the official parser), and a
  // header means the model decided, even if it decided "no speech".
  if (first.hasHeader || first.text)
    return { ...first, forcedLanguage: null, headerForced: false };
  // The quantized decoder occasionally stops before writing anything. Force
  // only the "language" keyword so the model still picks the language itself.
  const retry = await decode([QWEN_ASR_HEADER_KEYWORD_ID]);
  return { ...retry, forcedLanguage: null, headerForced: true };

  /** @param {ReadonlyArray<number>} prefixIds */
  async function decode(prefixIds) {
    model.reset();
    const prompt = buildQwenAsrPrompt({ audioTokens, prefixIds });
    const embeds = model.embed(prompt.ids);
    embeds.set(audio, prompt.audioStart * model.hiddenSize);

    /** @type {number[]} */
    const generated = [];
    let logits = await model.prefill(embeds, prompt.ids.length);
    let position = prompt.ids.length;
    while (generated.length < budget) {
      const token = argmax(logits);
      if (QWEN_ASR_EOS_IDS.includes(token)) break;
      generated.push(token);
      const loop = loopTail(generated);
      if (loop) {
        // Greedy decoding does not leave a loop; keep one copy and stop.
        generated.length -= loop.period * (loop.repeats - 1);
        break;
      }
      if (generated.length >= budget) break;
      logits = await model.step(model.embed([token]), position);
      position += 1;
    }
    // A forced prefix lives in the prompt, so prepend it for parsing.
    const { hasHeader, ...parsed } = parseQwenAsrOutput(
      [...prefixIds, ...generated],
      decoder,
    );
    return { ...parsed, hasHeader, tokens: generated };
  }
}

/**
 * The repeating tail of `tokens`, if it is long enough to be a loop.
 * @param {number[]} tokens
 * @returns {{ period: number, repeats: number } | null}
 */
function loopTail(tokens) {
  for (let period = 1; period <= MAX_LOOP_PERIOD; period += 1) {
    const repeats = Math.max(MIN_LOOP_REPEATS, Math.ceil(LOOP_TOKENS / period));
    const span = period * repeats;
    if (tokens.length < span) continue;
    let periodic = true;
    for (
      let index = tokens.length - span + period;
      index < tokens.length;
      index += 1
    ) {
      if (tokens[index] !== tokens[index - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return { period, repeats };
  }
  return null;
}

/** @param {Float32Array} values */
function argmax(values) {
  let best = 0;
  let bestValue = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] > bestValue) {
      bestValue = values[index];
      best = index;
    }
  }
  return best;
}
