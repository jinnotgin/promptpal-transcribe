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
 *   - Large groups (more than 8 speakers): sherpa-onnx's pyannote
 *     segmentation + CAM++ embeddings (34 MB) clustered into a user-given
 *     speaker count. It has no speaker cap but confuses speakers more than
 *     Nemotron, so it is only used when the user asks for it.
 *   - Chinese word timings: Qwen3-ForcedAligner q4 (~1 GB) runs after ASR,
 *     once Qwen3-ASR is unloaded, so the two are never resident together.
 */

/**
 * @typedef {'en' | 'zh'} TranscriptionLanguage
 * @typedef {'solo' | 'group' | 'large'} SpeakerMode
 * @typedef {'nemotron' | 'sortformer'} SpeakerModel
 * @typedef {{ engine: 'parakeet', variant: 'fp16' | 'int8' } | { engine: 'qwen3-asr', variant: 'q4f16' | 'q4' }} AsrSelection
 * @typedef {{ engine: 'nemotron', variant: 'int8', maxSpeakers: 8 } | { engine: 'sortformer', variant: 'fp32', maxSpeakers: 4 } | { engine: 'sherpa', variant: 'campplus', numSpeakers: number }} DiarizationSelection
 * @typedef {{ engine: 'qwen3-forced-aligner', variant: 'q4' }} AlignerSelection
 * @typedef {{
 *   available: boolean,
 *   unavailableReason: string | null,
 *   asr: AsrSelection,
 *   diarization: DiarizationSelection | null,
 *   aligner: AlignerSelection | null,
 *   diarizeFirst: boolean,
 *   assetKeys: string[],
 * }} EngineSelection
 */

export const TRANSCRIPTION_LANGUAGES = /** @type {const} */ (["en", "zh"]);
export const SPEAKER_MODES = /** @type {const} */ (["solo", "group", "large"]);
// Speaker labels run from "Speaker A" to "Speaker Z".
export const LARGE_GROUP_SPEAKERS = Object.freeze({
  min: 2,
  max: 26,
  default: 10,
});

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
const SHERPA_ASSETS = ["sherpaSegmentation", "sherpaEmbedding"];
// The aligner shares Qwen3-ASR's vocab.json (byte-identical).
const ALIGNER_ASSETS = ["alignerQ4", "alignerMerges"];

/**
 * @param {number | undefined} count
 */
export function clampLargeGroupSpeakers(count) {
  const value = Number.isFinite(count)
    ? Math.round(/** @type {number} */ (count))
    : LARGE_GROUP_SPEAKERS.default;
  return Math.min(
    LARGE_GROUP_SPEAKERS.max,
    Math.max(LARGE_GROUP_SPEAKERS.min, value),
  );
}

/**
 * @param {{
 *   language: TranscriptionLanguage,
 *   speakerMode: SpeakerMode,
 *   runtime: 'webgpu' | 'wasm',
 *   shaderF16: boolean,
 *   speakerModel?: SpeakerModel,
 *   speakerCount?: number,
 * }} request
 * @returns {EngineSelection}
 */
export function selectTranscriptionEngines({
  language,
  speakerMode,
  runtime,
  shaderF16,
  speakerModel = "nemotron",
  speakerCount,
}) {
  const isChinese = language === "zh";
  /** @type {AsrSelection} */
  const asr = isChinese
    ? { engine: "qwen3-asr", variant: shaderF16 ? "q4f16" : "q4" }
    : { engine: "parakeet", variant: runtime === "webgpu" ? "fp16" : "int8" };

  // Qwen output has no word timings, so Chinese needs speaker turns before
  // ASR; only the Nemotron and sherpa paths produce them.
  const useSortformer = !isChinese && speakerModel === "sortformer";
  /** @type {DiarizationSelection | null} */
  const diarization =
    speakerMode === "large"
      ? {
          engine: "sherpa",
          variant: "campplus",
          numSpeakers: clampLargeGroupSpeakers(speakerCount),
        }
      : speakerMode !== "group"
        ? null
        : useSortformer
          ? { engine: "sortformer", variant: "fp32", maxSpeakers: 4 }
          : { engine: "nemotron", variant: "int8", maxSpeakers: 8 };
  /** @type {AlignerSelection | null} */
  const aligner = isChinese
    ? { engine: "qwen3-forced-aligner", variant: "q4" }
    : null;

  const available = !isChinese || runtime === "webgpu";
  return {
    available,
    unavailableReason: available
      ? null
      : "Chinese transcription needs WebGPU. Use a desktop Chromium browser with WebGPU enabled.",
    asr,
    diarization,
    aligner,
    diarizeFirst: isChinese && diarization !== null,
    assetKeys: [
      ...(asr.engine === "qwen3-asr"
        ? QWEN_ASSETS[asr.variant]
        : PARAKEET_ASSETS[asr.variant]),
      ...(aligner ? ALIGNER_ASSETS : []),
      ...(!diarization
        ? []
        : diarization.engine === "sortformer"
          ? ["diarization"]
          : diarization.engine === "sherpa"
            ? SHERPA_ASSETS
            : NEMOTRON_ASSETS),
    ],
  };
}
