/**
 * @typedef {'webgpu' | 'wasm' | 'both' | 'diarization'} ModelRuntime
 * @typedef {{ url: string, cacheKey: string, runtime: ModelRuntime }} ModelAsset
 */

/** @type {Record<string, ModelAsset>} */
export const MODEL_ASSETS = {
  encoderFp16: {
    url: "https://huggingface.co/grikdotnet/parakeet-tdt-0.6b-fp16/resolve/main/encoder-model.fp16.onnx",
    cacheKey: "parakeet-encoder-fp16",
    runtime: "webgpu",
  },
  encoderInt8: {
    url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx",
    cacheKey: "parakeet-encoder-int8",
    runtime: "wasm",
  },
  decoder: {
    url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.int8.onnx",
    cacheKey: "parakeet-decoder",
    runtime: "both",
  },
  preprocessor: {
    url: "https://huggingface.co/grikdotnet/parakeet-tdt-0.6b-fp16/resolve/main/nemo128.onnx",
    cacheKey: "parakeet-nemo128",
    runtime: "both",
  },
  vocab: {
    url: "https://huggingface.co/grikdotnet/parakeet-tdt-0.6b-fp16/resolve/main/vocab.txt",
    cacheKey: "parakeet-vocab",
    runtime: "both",
  },
  diarization: {
    url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/diar_streaming_sortformer_4spk-v2.1.onnx",
    cacheKey: "sortformer-diarization",
    runtime: "diarization",
  },
};

export const FFMPEG_ASSETS = {
  core: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
  wasm: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
};

/**
 * Returns the model asset keys required for a given runtime and diarization setting.
 * @param {'webgpu' | 'wasm'} runtime
 * @param {boolean} diarization
 * @returns {string[]}
 */
export function getRequiredAssetKeys(runtime, diarization) {
  const keys = [];
  keys.push(runtime === "webgpu" ? "encoderFp16" : "encoderInt8");
  keys.push("decoder", "vocab");
  if (diarization) keys.push("diarization");
  return keys;
}
