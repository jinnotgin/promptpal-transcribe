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

/** A run this long of one token is a decoding loop, not speech. */
const REPEAT_LIMIT = 16;

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
 *   fallbackLanguage?: QwenLanguage | null,
 *   maxNewTokens?: number,
 * }} options
 * @returns {Promise<{ text: string, language: string | null, tokens: number[], forcedLanguage: QwenLanguage | null }>}
 */
export async function generateQwenTranscript({
  pcm,
  model,
  decoder,
  language = null,
  fallbackLanguage = null,
  maxNewTokens,
}) {
  const { features, frames } = computeQwenAsrFeatures(pcm);
  if (!frames)
    return { text: "", language: null, tokens: [], forcedLanguage: null };
  const audio = await model.encode(features, frames);
  const audioTokens = audio.length / model.hiddenSize;
  if (audioTokens !== qwenAudioTokenCount(frames)) {
    throw new Error(
      `Qwen3-ASR encoder returned ${audioTokens} tokens, expected ${qwenAudioTokenCount(frames)}`,
    );
  }
  const budget = maxNewTokens ?? qwenMaxNewTokens(pcm.length / 16000);

  const first = await decode(language);
  if (language || !fallbackLanguage)
    return { ...first, forcedLanguage: language };
  // The quantized decoder occasionally skips the "language X" header and
  // stops at once; forcing the header avoids that knife edge.
  if (first.language && first.text) return { ...first, forcedLanguage: null };
  const retry = await decode(fallbackLanguage);
  return { ...retry, forcedLanguage: fallbackLanguage };

  /** @param {QwenLanguage | null} forced */
  async function decode(forced) {
    model.reset();
    const prompt = buildQwenAsrPrompt({ audioTokens, language: forced });
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
      if (isRepeating(generated)) {
        while (generated.length && generated[generated.length - 1] === token) {
          generated.pop();
        }
        break;
      }
      if (generated.length >= budget) break;
      logits = await model.step(model.embed([token]), position);
      position += 1;
    }
    // A forced header lives in the prompt, so prepend it for parsing.
    const parsed = parseQwenAsrOutput(
      forced
        ? [...QWEN_ASR_LANGUAGE_PREFIX_IDS[forced], ...generated]
        : generated,
      decoder,
    );
    return { ...parsed, tokens: generated };
  }
}

/** @param {number[]} tokens */
function isRepeating(tokens) {
  if (tokens.length < REPEAT_LIMIT) return false;
  const last = tokens[tokens.length - 1];
  for (
    let index = tokens.length - REPEAT_LIMIT;
    index < tokens.length;
    index += 1
  ) {
    if (tokens[index] !== last) return false;
  }
  return true;
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
