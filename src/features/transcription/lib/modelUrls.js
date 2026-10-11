/**
 * @typedef {'webgpu' | 'wasm' | 'both' | 'diarization'} ModelRuntime
 * @typedef {{ url: string, cacheKey: string, runtime: ModelRuntime }} ModelAsset
 */

const NEMOTRON_ONNX_BASE =
  "https://huggingface.co/onnx-community/Nemotron-3-Diarization-ONNX/resolve/353b6f8ad2cac3580e982d7fbdf0a010786b0406/onnx";
const SHERPA_SEGMENTATION_BASE =
  "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0";
const SENSEVOICE_BASE =
  "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07";
const SHERPA_EMBEDDING_BASE =
  "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf";

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
  // SenseVoice-Small int8 (239 MB) for Chinese/English. Its MatMulInteger
  // ops have no WebGPU kernel, so it always runs on WASM.
  senseVoiceInt8: {
    url: `${SENSEVOICE_BASE}/model.int8.onnx`,
    cacheKey: "sensevoice-small-int8",
    runtime: "wasm",
  },
  senseVoiceTokens: {
    url: `${SENSEVOICE_BASE}/tokens.txt`,
    cacheKey: "sensevoice-small-tokens",
    runtime: "wasm",
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
  sherpaSegmentation: {
    url: `${SHERPA_SEGMENTATION_BASE}/model.onnx`,
    cacheKey: "sherpa-pyannote-segmentation-3.0",
    runtime: "diarization",
  },
  sherpaEmbedding: {
    url: `${SHERPA_EMBEDDING_BASE}/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    cacheKey: "sherpa-campplus-zh-en-advanced",
    runtime: "diarization",
  },
};

/** External-data file names the ONNX graphs reference. */
export const MODEL_EXTERNAL_DATA_PATHS = {
  nemotronInt8Data: "model_quantized.onnx_data",
};

export const FFMPEG_ASSETS = {
  core: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
  wasm: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
};
