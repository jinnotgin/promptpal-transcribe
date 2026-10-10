/**
 * Chooses the ASR and diarization models for a transcription request.
 *
 * Model variants follow Parakeet's runtime tiers so memory stays comparable
 * (download size used as the proxy):
 *   - WebGPU tier: Parakeet fp16 encoder ~1.2 GB. Qwen3-ASR q4f16 ~0.88 GB
 *     with shader-f16, otherwise q4 ~1.28 GB.
 *   - WASM tier: Parakeet int8 ~0.64 GB. Qwen3-ASR is not offered: its CPU
 *     path is ~30x slower than WebGPU and larger than this tier's budget.
 *   - Diarization: Nemotron int8 (120 MB) on every tier, run on WebGPU or
 *     WASM, replacing the 469 MB fp32 Sortformer. int8 matches fp32 accuracy
 *     on real meetings; the smaller 4-bit q4f16 export merges speakers.
 */

/**
 * @typedef {'en' | 'zh'} TranscriptionLanguage
 * @typedef {'solo' | 'group'} SpeakerMode
 * @typedef {'nemotron' | 'sortformer'} SpeakerModel
 * @typedef {{ engine: 'parakeet', variant: 'fp16' | 'int8' } | { engine: 'qwen3-asr', variant: 'q4f16' | 'q4' }} AsrSelection
 * @typedef {{ engine: 'nemotron', variant: 'int8', maxSpeakers: 8 } | { engine: 'sortformer', variant: 'fp32', maxSpeakers: 4 }} DiarizationSelection
 * @typedef {{
 *   available: boolean,
 *   unavailableReason: string | null,
 *   asr: AsrSelection,
 *   diarization: DiarizationSelection | null,
 *   diarizeFirst: boolean,
 *   assetKeys: string[],
 * }} EngineSelection
 */

export const TRANSCRIPTION_LANGUAGES = /** @type {const} */ (["en", "zh"]);
export const SPEAKER_MODES = /** @type {const} */ (["solo", "group"]);

/** @type {Record<'fp16' | 'int8', string[]>} */
const PARAKEET_ASSETS = {
  fp16: ["encoderFp16", "decoder", "vocab"],
  int8: ["encoderInt8", "decoder", "vocab"],
};

/** @type {Record<'q4f16' | 'q4', string[]>} */
const QWEN_ASSETS = {
  q4f16: [
    "qwenEncoderFp16",
    "qwenDecoderInitQ4f16",
    "qwenDecoderStepQ4f16",
    "qwenDecoderWeightsQ4f16",
    "qwenEmbedTokens",
    "qwenEmbedScales",
    "qwenVocab",
  ],
  q4: [
    "qwenEncoderFp32",
    "qwenDecoderInitQ4",
    "qwenDecoderStepQ4",
    "qwenDecoderWeightsQ4",
    "qwenEmbedTokens",
    "qwenEmbedScales",
    "qwenVocab",
  ],
};

const NEMOTRON_ASSETS = ["nemotronInt8", "nemotronInt8Data"];

/**
 * @param {{
 *   language: TranscriptionLanguage,
 *   speakerMode: SpeakerMode,
 *   runtime: 'webgpu' | 'wasm',
 *   shaderF16: boolean,
 *   speakerModel?: SpeakerModel,
 * }} request
 * @returns {EngineSelection}
 */
export function selectTranscriptionEngines({
  language,
  speakerMode,
  runtime,
  shaderF16,
  speakerModel = "nemotron",
}) {
  const isChinese = language === "zh";
  /** @type {AsrSelection} */
  const asr = isChinese
    ? { engine: "qwen3-asr", variant: shaderF16 ? "q4f16" : "q4" }
    : { engine: "parakeet", variant: runtime === "webgpu" ? "fp16" : "int8" };

  // Qwen output has no word timings, so Chinese needs speaker turns before
  // ASR; only the Nemotron path produces them.
  const useSortformer = !isChinese && speakerModel === "sortformer";
  /** @type {DiarizationSelection | null} */
  const diarization =
    speakerMode !== "group"
      ? null
      : useSortformer
        ? { engine: "sortformer", variant: "fp32", maxSpeakers: 4 }
        : { engine: "nemotron", variant: "int8", maxSpeakers: 8 };

  const available = !isChinese || runtime === "webgpu";
  return {
    available,
    unavailableReason: available
      ? null
      : "Chinese transcription needs WebGPU. Use a desktop Chromium browser with WebGPU enabled.",
    asr,
    diarization,
    diarizeFirst: isChinese && diarization !== null,
    assetKeys: [
      ...(asr.engine === "qwen3-asr"
        ? QWEN_ASSETS[asr.variant]
        : PARAKEET_ASSETS[asr.variant]),
      ...(!diarization
        ? []
        : diarization.engine === "sortformer"
          ? ["diarization"]
          : NEMOTRON_ASSETS),
    ],
  };
}
