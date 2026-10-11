/**
 * Chooses the ASR and diarization models for a transcription request.
 *
 *   - English ASR: Parakeet fp16 on WebGPU, int8 on WASM.
 *   - Chinese and mixed ASR: SenseVoice-Small int8 on WASM on every runtime
 *     (its quantized ops have no WebGPU kernel); Parakeet has no Chinese.
 *     Chinese passes SenseVoice the "zh" language hint; mixed audio uses
 *     "auto" so it can follow Mandarin/English code-switching.
 *   - Groups of up to 8 speakers: Nemotron 3 Diarization int8 (120 MB) on
 *     WebGPU or WASM. int8 matches fp32 accuracy on real meetings; the
 *     smaller 4-bit q4f16 export merges speakers.
 *   - Large groups (more than 8 speakers): sherpa-onnx's pyannote
 *     segmentation + CAM++ embeddings (34 MB) clustered into a user-given
 *     speaker count. It has no speaker cap but confuses speakers more than
 *     Nemotron, so it is only used when the user asks for it.
 */

/**
 * @typedef {'solo' | 'group' | 'large'} SpeakerMode
 * @typedef {'en' | 'zh' | 'zh-en'} TranscriptionLanguage
 * @typedef {'zh' | 'auto'} SenseVoiceLanguage
 * @typedef {{ engine: 'parakeet', variant: 'fp16' | 'int8' } | { engine: 'sensevoice', variant: 'int8', language: SenseVoiceLanguage }} AsrSelection
 * @typedef {{ engine: 'nemotron', variant: 'int8', maxSpeakers: 8 } | { engine: 'sherpa', variant: 'campplus', numSpeakers: number }} DiarizationSelection
 * @typedef {{
 *   asr: AsrSelection,
 *   diarization: DiarizationSelection | null,
 *   assetKeys: string[],
 * }} EngineSelection
 */

export const GROUP_MAX_SPEAKERS = 8;
// Speaker labels run from "Speaker A" to "Speaker Z".
export const LARGE_GROUP_SPEAKERS = Object.freeze({
  min: GROUP_MAX_SPEAKERS + 1,
  max: 26,
  default: 10,
});

/** @type {Record<'fp16' | 'int8', string[]>} */
const PARAKEET_ASSETS = {
  fp16: ["encoderFp16", "decoder", "vocab"],
  int8: ["encoderInt8", "decoder", "vocab"],
};
const SENSEVOICE_ASSETS = ["senseVoiceInt8", "senseVoiceTokens"];
const NEMOTRON_ASSETS = ["nemotronInt8", "nemotronInt8Data"];

/** @type {readonly TranscriptionLanguage[]} */
export const TRANSCRIPTION_LANGUAGES = Object.freeze(["en", "zh", "zh-en"]);

/**
 * @param {unknown} value
 * @returns {TranscriptionLanguage}
 */
export function normalizeTranscriptionLanguage(value) {
  return TRANSCRIPTION_LANGUAGES.includes(
    /** @type {TranscriptionLanguage} */ (value),
  )
    ? /** @type {TranscriptionLanguage} */ (value)
    : "en";
}
const SHERPA_ASSETS = ["sherpaSegmentation", "sherpaEmbedding"];

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
 *   speakerMode: SpeakerMode,
 *   runtime: 'webgpu' | 'wasm',
 *   speakerCount?: number,
 *   language?: TranscriptionLanguage,
 * }} request
 * @returns {EngineSelection}
 */
export function selectTranscriptionEngines({
  speakerMode,
  runtime,
  speakerCount,
  language = "en",
}) {
  /** @type {AsrSelection} */
  const asr =
    language === "en"
      ? { engine: "parakeet", variant: runtime === "webgpu" ? "fp16" : "int8" }
      : {
          engine: "sensevoice",
          variant: "int8",
          language: language === "zh" ? "zh" : "auto",
        };
  /** @type {DiarizationSelection | null} */
  const diarization =
    speakerMode === "large"
      ? {
          engine: "sherpa",
          variant: "campplus",
          numSpeakers: clampLargeGroupSpeakers(speakerCount),
        }
      : speakerMode === "group"
        ? { engine: "nemotron", variant: "int8", maxSpeakers: 8 }
        : null;

  return {
    asr,
    diarization,
    assetKeys: [
      ...(asr.engine === "sensevoice"
        ? SENSEVOICE_ASSETS
        : PARAKEET_ASSETS[asr.variant]),
      ...(!diarization
        ? []
        : diarization.engine === "sherpa"
          ? SHERPA_ASSETS
          : NEMOTRON_ASSETS),
    ],
  };
}
