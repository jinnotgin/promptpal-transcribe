/**
 * @typedef {'webgpu' | 'wasm' | 'both' | 'diarization'} ModelRuntime
 * @typedef {{ url: string, cacheKey: string, runtime: ModelRuntime }} ModelAsset
 */

const NEMOTRON_ONNX_BASE =
  "https://huggingface.co/onnx-community/Nemotron-3-Diarization-ONNX/resolve/353b6f8ad2cac3580e982d7fbdf0a010786b0406/onnx";
const QWEN_ASR_BASE =
  "https://huggingface.co/jiangzhuo9357/Qwen3-ASR-0.6B-ONNX/resolve/4a01b95fafe2c9e3af77e33c18bbb7de349c62f6";

/**
 * @param {string} file
 * @param {string} cacheKey
 * @returns {ModelAsset}
 */
function qwenAsset(file, cacheKey) {
  return { url: `${QWEN_ASR_BASE}/${file}`, cacheKey, runtime: "webgpu" };
}

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
  nemotronInt8: {
    url: `${NEMOTRON_ONNX_BASE}/model_quantized.onnx`,
    cacheKey: "nemotron3-diarization-int8",
    runtime: "diarization",
  },
  nemotronInt8Data: {
    url: `${NEMOTRON_ONNX_BASE}/model_quantized.onnx_data`,
    cacheKey: "nemotron3-diarization-int8-data",
    runtime: "diarization",
  },
  qwenEncoderFp16: qwenAsset("encoder.fp16.onnx", "qwen3-asr-encoder-fp16"),
  qwenEncoderFp32: qwenAsset("encoder.onnx", "qwen3-asr-encoder-fp32"),
  qwenDecoderInitQ4f16: qwenAsset(
    "decoder_init.q4f16.onnx",
    "qwen3-asr-decoder-init-q4f16",
  ),
  qwenDecoderStepQ4f16: qwenAsset(
    "decoder_step.q4f16.onnx",
    "qwen3-asr-decoder-step-q4f16",
  ),
  qwenDecoderWeightsQ4f16: qwenAsset(
    "decoder_weights.q4f16.data",
    "qwen3-asr-decoder-weights-q4f16",
  ),
  qwenDecoderInitQ4: qwenAsset(
    "decoder_init.int4.onnx",
    "qwen3-asr-decoder-init-q4",
  ),
  qwenDecoderStepQ4: qwenAsset(
    "decoder_step.int4.onnx",
    "qwen3-asr-decoder-step-q4",
  ),
  qwenDecoderWeightsQ4: qwenAsset(
    "decoder_weights.int4.data",
    "qwen3-asr-decoder-weights-q4",
  ),
  qwenEmbedTokens: qwenAsset("embed_tokens.int8.bin", "qwen3-asr-embed-tokens"),
  qwenEmbedScales: qwenAsset("embed_scales.f32.bin", "qwen3-asr-embed-scales"),
  qwenVocab: qwenAsset("vocab.json", "qwen3-asr-vocab"),
};

/** External-data file names the ONNX graphs reference. */
export const MODEL_EXTERNAL_DATA_PATHS = {
  nemotronInt8Data: "model_quantized.onnx_data",
  qwenDecoderWeightsQ4f16: "decoder_weights.q4f16.data",
  qwenDecoderWeightsQ4: "decoder_weights.int4.data",
};

export const FFMPEG_ASSETS = {
  core: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
  wasm: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
};
