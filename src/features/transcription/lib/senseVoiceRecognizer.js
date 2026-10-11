/**
 * One SenseVoice-Small pass over a chunk of 16 kHz audio: features, the ONNX
 * session, CTC greedy search and timestamped words. Runtime-agnostic: the
 * caller supplies the onnxruntime session and Tensor class, so the same code
 * runs in the worker, in Node parity checks and against fakes in tests.
 */

import { computeSenseVoiceFeatures } from "./senseVoiceFrontend.js";
import {
  SENSEVOICE_PROMPT_FRAMES,
  ctcGreedyDecode,
  decodeSenseVoiceTokens,
} from "./senseVoiceDecoding.js";

const SAMPLE_RATE = 16000;

/**
 * @typedef {{
 *   inputNames: readonly string[],
 *   outputNames: readonly string[],
 *   run: (feeds: Record<string, any>) => Promise<Record<string, { data: any, dims: readonly number[] }>>,
 * }} SenseVoiceSession
 */

/**
 * @param {{
 *   session: SenseVoiceSession,
 *   Tensor: new (type: any, data: any, dims: number[]) => any,
 *   metadata: import('./senseVoiceFrontend.js').SenseVoiceMetadata,
 *   symbols: string[],
 *   language?: string,
 *   useItn?: boolean,
 * }} options
 */
export function createSenseVoiceRecognizer({
  session,
  Tensor,
  metadata,
  symbols,
  language = "auto",
  useItn = true,
}) {
  const languageId =
    metadata.languageIds[language] ?? metadata.languageIds.auto ?? 0;
  const textNormId = useItn ? metadata.withItn : metadata.withoutItn;
  const [xName, lengthName, languageName, textNormName] = session.inputNames;
  const [logitsName] = session.outputNames;

  /**
   * @param {Float32Array} pcm 16 kHz mono samples in [-1, 1]
   * @param {number} offsetSeconds where the chunk starts in the recording
   * @returns {Promise<import('./senseVoiceDecoding.js').SenseVoiceResult>}
   */
  async function transcribe(pcm, offsetSeconds) {
    const timing = { offsetSeconds, durationSeconds: pcm.length / SAMPLE_RATE };
    const features = computeSenseVoiceFeatures(pcm, metadata);
    if (features.frames === 0) {
      return decodeSenseVoiceTokens({ ids: [], frames: [] }, symbols, timing);
    }
    const outputs = await session.run({
      [xName]: new Tensor("float32", features.data, [
        1,
        features.frames,
        features.dim,
      ]),
      [lengthName]: new Tensor("int32", Int32Array.of(features.frames), [1]),
      [languageName]: new Tensor("int32", Int32Array.of(languageId), [1]),
      [textNormName]: new Tensor("int32", Int32Array.of(textNormId), [1]),
    });
    const logits = outputs[logitsName];
    const vocabSize = logits.dims[2];
    // Decode only frames backed by real input: prompt frames plus features.
    const frames = Math.min(
      logits.dims[1],
      features.frames + SENSEVOICE_PROMPT_FRAMES,
    );
    const decoded = ctcGreedyDecode(
      /** @type {Float32Array} */ (logits.data),
      frames,
      vocabSize,
    );
    return decodeSenseVoiceTokens(decoded, symbols, timing);
  }

  return { transcribe };
}
