/**
 * onnxruntime-web adapter for the Qwen3-ASR-0.6B browser export (layout v2).
 *
 * Graph contracts (see the export's README):
 *   encoder:      mel [1,128,T] f32 -> audio_features [1,A,1024] f32
 *   decoder_init: input_embeds [1,S,1024], position_ids [1,S]
 *                 -> logits [1,1,V], present_keys/values [28,1,8,S,128]
 *   decoder_step: input_embeds [1,1,1024], position_ids [1,1], past_keys/values
 *                 -> logits [1,1,V], present_keys/values [28,1,8,S+1,128]
 * The q4f16 decoders use fp16 for every float tensor; q4 uses fp32. Both
 * decoders share one external weights file. The KV cache stays on the GPU
 * between steps when running on WebGPU.
 */

import { float16DataToFloat32, float32ToFloat16Data } from "./float16.js";

export const QWEN_ASR_HIDDEN_SIZE = 1024;
const MEL_BINS = 128;

/**
 * @typedef {typeof import('onnxruntime-web')} Ort
 * @typedef {import('onnxruntime-web').InferenceSession} Session
 * @typedef {import('onnxruntime-web').Tensor} Tensor
 */

/**
 * @param {{
 *   ort: Ort,
 *   variant: 'q4f16' | 'q4',
 *   executionProviders: string[],
 *   encoder: ArrayBuffer,
 *   decoderInit: ArrayBuffer,
 *   decoderStep: ArrayBuffer,
 *   decoderWeights: ArrayBuffer,
 *   decoderWeightsPath: string,
 *   embedTokens: ArrayBuffer,
 *   embedScales: ArrayBuffer,
 * }} options
 * @returns {Promise<import('./qwenAsrGeneration.js').QwenAsrModel & { dispose: () => Promise<void> }>}
 */
export async function createQwenOrtModel(options) {
  const { ort, variant, executionProviders } = options;
  const half = variant === "q4f16";
  const onGpu = executionProviders[0] === "webgpu";
  const weights = new Uint8Array(options.decoderWeights);
  const decoderOptions = {
    executionProviders,
    graphOptimizationLevel: /** @type {const} */ ("all"),
    externalData: [{ path: options.decoderWeightsPath, data: weights }],
    ...(onGpu
      ? {
          preferredOutputLocation: {
            logits: /** @type {const} */ ("cpu"),
            present_keys: /** @type {const} */ ("gpu-buffer"),
            present_values: /** @type {const} */ ("gpu-buffer"),
          },
        }
      : {}),
  };

  const encoder = await ort.InferenceSession.create(
    new Uint8Array(options.encoder),
    {
      executionProviders,
      graphOptimizationLevel: "all",
    },
  );
  const decoderInit = await ort.InferenceSession.create(
    new Uint8Array(options.decoderInit),
    decoderOptions,
  );
  const decoderStep = await ort.InferenceSession.create(
    new Uint8Array(options.decoderStep),
    decoderOptions,
  );

  const embedTable = new Int8Array(options.embedTokens);
  const embedScales = new Float32Array(options.embedScales);

  /** @type {Tensor | null} */
  let pastKeys = null;
  /** @type {Tensor | null} */
  let pastValues = null;

  function releaseCache() {
    pastKeys?.dispose();
    pastValues?.dispose();
    pastKeys = null;
    pastValues = null;
  }

  /** @param {Float32Array} values @param {number[]} dims */
  function floatTensor(values, dims) {
    return half
      ? new ort.Tensor("float16", float32ToFloat16Data(values), dims)
      : new ort.Tensor("float32", values, dims);
  }

  /** @param {Tensor} tensor */
  function readLogits(tensor) {
    const data = /** @type {ArrayLike<number>} */ (tensor.data);
    return tensor.type === "float16"
      ? float16DataToFloat32(data)
      : Float32Array.from(data);
  }

  /** @param {Record<string, Tensor>} outputs */
  function keepCache(outputs) {
    releaseCache();
    pastKeys = outputs.present_keys;
    pastValues = outputs.present_values;
    const logits = readLogits(outputs.logits);
    outputs.logits.dispose();
    return logits;
  }

  return {
    hiddenSize: QWEN_ASR_HIDDEN_SIZE,

    async encode(features, frames) {
      const mel = new ort.Tensor("float32", features, [1, MEL_BINS, frames]);
      const outputs = await encoder.run({ mel });
      try {
        return Float32Array.from(
          /** @type {Float32Array} */ (outputs.audio_features.data),
        );
      } finally {
        mel.dispose();
        Object.values(outputs).forEach((tensor) => tensor.dispose());
      }
    },

    embed(ids) {
      const out = new Float32Array(ids.length * QWEN_ASR_HIDDEN_SIZE);
      for (let row = 0; row < ids.length; row += 1) {
        const id = ids[row];
        const scale = embedScales[id];
        const source = id * QWEN_ASR_HIDDEN_SIZE;
        const target = row * QWEN_ASR_HIDDEN_SIZE;
        for (let column = 0; column < QWEN_ASR_HIDDEN_SIZE; column += 1) {
          out[target + column] = embedTable[source + column] * scale;
        }
      }
      return out;
    },

    async prefill(embeds, rows) {
      releaseCache();
      const inputEmbeds = floatTensor(embeds, [1, rows, QWEN_ASR_HIDDEN_SIZE]);
      const positionIds = new ort.Tensor(
        "int64",
        BigInt64Array.from({ length: rows }, (_, index) => BigInt(index)),
        [1, rows],
      );
      try {
        return keepCache(
          await decoderInit.run({
            input_embeds: inputEmbeds,
            position_ids: positionIds,
          }),
        );
      } finally {
        inputEmbeds.dispose();
        positionIds.dispose();
      }
    },

    async step(embed, position) {
      if (!pastKeys || !pastValues)
        throw new Error("Qwen3-ASR step before prefill");
      const inputEmbeds = floatTensor(embed, [1, 1, QWEN_ASR_HIDDEN_SIZE]);
      const positionIds = new ort.Tensor(
        "int64",
        BigInt64Array.of(BigInt(position)),
        [1, 1],
      );
      try {
        return keepCache(
          await decoderStep.run({
            input_embeds: inputEmbeds,
            position_ids: positionIds,
            past_keys: pastKeys,
            past_values: pastValues,
          }),
        );
      } finally {
        inputEmbeds.dispose();
        positionIds.dispose();
      }
    },

    reset: releaseCache,

    async dispose() {
      releaseCache();
      await Promise.all([
        encoder.release(),
        decoderInit.release(),
        decoderStep.release(),
      ]);
    },
  };
}
