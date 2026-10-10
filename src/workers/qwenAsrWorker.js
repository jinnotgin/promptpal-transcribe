/**
 * Qwen3-ASR-0.6B worker (Chinese, English and code-switched speech, WebGPU).
 *
 * Speaks the same protocol as asrWorker.js (`init`, `process`, `cancel`) so
 * the file and live pipelines can swap engines. Each `process` call
 * transcribes one region; Qwen has no word timestamps, so the region becomes
 * sentence segments with proportional timing and an optional speaker label.
 */

// The WebGPU build: the default bundle's WebGPU backend returns wrong
// decoder logits for this export (onnxruntime-web 1.30).
import * as ort from "onnxruntime-web/webgpu";
import { getOrDownloadModelAsset } from "@/features/transcription/lib/modelCache.js";
import { MODEL_EXTERNAL_DATA_PATHS } from "@/features/transcription/lib/modelUrls.js";
import { configureOrtWasm } from "@/features/transcription/lib/ortRuntime.js";
import { createQwenOrtModel } from "@/features/transcription/lib/qwenAsrOrtModel.js";
import { generateQwenTranscript } from "@/features/transcription/lib/qwenAsrGeneration.js";
import { createQwenTokenDecoder } from "@/features/transcription/lib/qwenAsrPrompt.js";
import { buildTimedSegments } from "@/features/transcription/lib/qwenAsrSegments.js";

const SAMPLE_RATE = 16000;

/** @type {Awaited<ReturnType<typeof createQwenOrtModel>> | null} */
let model = null;
/** @type {ReturnType<typeof createQwenTokenDecoder> | null} */
let tokenDecoder = null;
/** @type {AbortController | null} */
let initAbortController = null;
let cancelled = false;

/**
 * @param {'q4f16' | 'q4'} variant
 */
function assetKeysFor(variant) {
  return variant === "q4f16"
    ? {
        encoder: "qwenEncoderFp16",
        decoderInit: "qwenDecoderInitQ4f16",
        decoderStep: "qwenDecoderStepQ4f16",
        decoderWeights: "qwenDecoderWeightsQ4f16",
      }
    : {
        encoder: "qwenEncoderFp32",
        decoderInit: "qwenDecoderInitQ4",
        decoderStep: "qwenDecoderStepQ4",
        decoderWeights: "qwenDecoderWeightsQ4",
      };
}

/** @param {'q4f16' | 'q4'} variant */
async function init(variant) {
  cancelled = false;
  initAbortController = new AbortController();
  const signal = initAbortController.signal;
  const progress = (payload) =>
    self.postMessage({ type: "model-progress", payload });
  const keys = assetKeysFor(variant);
  const [
    encoder,
    decoderInit,
    decoderStep,
    decoderWeights,
    embedTokens,
    embedScales,
    vocab,
  ] = await Promise.all(
    [
      keys.encoder,
      keys.decoderInit,
      keys.decoderStep,
      keys.decoderWeights,
      "qwenEmbedTokens",
      "qwenEmbedScales",
      "qwenVocab",
    ].map((key) => getOrDownloadModelAsset(key, signal, progress)),
  );
  if (cancelled || signal.aborted)
    throw new DOMException("Aborted", "AbortError");

  self.postMessage({ type: "model-loading", payload: { percent: 30 } });
  configureOrtWasm(ort);
  tokenDecoder = createQwenTokenDecoder(
    JSON.parse(new TextDecoder().decode(vocab)),
  );
  model = await createQwenOrtModel({
    ort,
    variant,
    executionProviders: ["webgpu"],
    encoder,
    decoderInit,
    decoderStep,
    decoderWeights,
    decoderWeightsPath: MODEL_EXTERNAL_DATA_PATHS[keys.decoderWeights],
    embedTokens,
    embedScales,
  });
  self.postMessage({ type: "model-loading", payload: { percent: 100 } });
}

/**
 * @param {Float32Array} audio
 * @param {number} chunkStart
 * @param {string | null} speaker
 */
async function processChunk(audio, chunkStart, speaker) {
  if (!model || !tokenDecoder)
    throw new Error("Qwen3-ASR model is not initialized");
  const startedAt = performance.now();
  const result = await generateQwenTranscript({
    pcm: audio,
    model,
    decoder: tokenDecoder,
    fallbackLanguage: "zh",
  });
  const duration = audio.length / SAMPLE_RATE;
  return {
    segments: buildTimedSegments(result.text, {
      start: chunkStart,
      end: chunkStart + duration,
      speaker,
    }),
    diagnostics: {
      engine: "qwen3-asr",
      language: result.language,
      forcedLanguage: result.forcedLanguage,
      generatedTokens: result.tokens.length,
      textLength: result.text.length,
      rtf: (performance.now() - startedAt) / 1000 / Math.max(0.01, duration),
    },
  };
}

self.onmessage = async (event) => {
  const { type, payload } = event.data;
  switch (type) {
    case "init":
      try {
        await init(payload.variant || "q4f16");
        if (!cancelled) self.postMessage({ type: "ready" });
      } catch (error) {
        if (!cancelled) {
          self.postMessage({
            type: "error",
            payload: {
              code: "ASR_INIT_FAILED",
              message: error?.message || String(error),
            },
          });
        }
      }
      break;

    case "process":
      try {
        if (cancelled) return;
        const { segments, diagnostics } = await processChunk(
          new Float32Array(payload.chunkAudio),
          payload.chunkStart,
          payload.speaker ?? null,
        );
        if (cancelled) return;
        self.postMessage({
          type: "diagnostics",
          payload: {
            ...diagnostics,
            chunkIndex: payload.chunkIndex,
            chunkStart: payload.chunkStart,
          },
        });
        self.postMessage({
          type: "progress",
          payload: {
            percent: ((payload.chunkIndex + 1) / payload.totalChunks) * 100,
          },
        });
        self.postMessage({
          type: "partial",
          payload: { segments, diagnostics, chunkIndex: payload.chunkIndex },
        });
      } catch (error) {
        if (!cancelled) {
          self.postMessage({
            type: "error",
            payload: {
              code: "ASR_PROCESS_FAILED",
              message: error?.message || String(error),
            },
          });
        }
      }
      break;

    case "cancel":
      cancelled = true;
      initAbortController?.abort();
      await model?.dispose().catch(() => {});
      model = null;
      break;
  }
};
