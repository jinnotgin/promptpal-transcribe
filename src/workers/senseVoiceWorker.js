/**
 * Chinese/English ASR worker (SenseVoice-Small int8 via onnxruntime-web).
 *
 * Speaks the same protocol as asrWorker.js (`init`, `process`, `cancel`;
 * replies `model-progress`, `model-loading`, `ready`, `diagnostics`,
 * `progress`, `partial`, `error`) so useAsrInference can drive either.
 * Language is auto-detected per chunk, which handles Mandarin with English
 * mixed in. Always WASM: the int8 graph's MatMulInteger has no WebGPU kernel.
 */

import * as ort from "onnxruntime-web";
import { getOrDownloadModelAsset } from "@/features/transcription/lib/modelCache.js";
import { configureOrtWasm } from "@/features/transcription/lib/ortRuntime.js";
import { readOnnxMetadata } from "@/features/transcription/lib/onnxMetadata.js";
import { parseSenseVoiceMetadata } from "@/features/transcription/lib/senseVoiceFrontend.js";
import { parseTokens } from "@/features/transcription/lib/senseVoiceDecoding.js";
import { createSenseVoiceRecognizer } from "@/features/transcription/lib/senseVoiceRecognizer.js";
import { wordsToSegments } from "@/features/transcription/lib/asrWordSegments.js";

const SAMPLE_RATE = 16000;

/** @type {import('onnxruntime-web').InferenceSession | null} */
let session = null;
/** @type {ReturnType<typeof createSenseVoiceRecognizer> | null} */
let recognizer = null;
let cancelled = false;
/** @type {AbortController | null} */
let initAbortController = null;

/**
 * @param {{ model: string, tokens: string }} assetKeys
 */
async function init(assetKeys) {
  cancelled = false;
  initAbortController = new AbortController();
  const signal = initAbortController.signal;
  const progress = (payload) => {
    self.postMessage({ type: "model-progress", payload });
  };

  const [modelBuffer, tokensBuffer] = await Promise.all([
    getOrDownloadModelAsset(assetKeys.model, signal, progress),
    getOrDownloadModelAsset(assetKeys.tokens, signal, progress),
  ]);
  if (cancelled || signal.aborted)
    throw new DOMException("Aborted", "AbortError");

  self.postMessage({ type: "model-loading", payload: { percent: 20 } });
  const metadata = parseSenseVoiceMetadata(readOnnxMetadata(modelBuffer));
  const symbols = parseTokens(new TextDecoder().decode(tokensBuffer));

  self.postMessage({ type: "model-loading", payload: { percent: 45 } });
  configureOrtWasm(ort);
  session = await ort.InferenceSession.create(new Uint8Array(modelBuffer), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  recognizer = createSenseVoiceRecognizer({
    session,
    Tensor: ort.Tensor,
    metadata,
    symbols,
    language: "auto",
  });
  self.postMessage({ type: "model-loading", payload: { percent: 100 } });
}

async function cleanupModel() {
  const current = session;
  session = null;
  recognizer = null;
  try {
    await current?.release();
  } catch {
    // Worker termination is still sufficient cleanup if release fails.
  }
}

/**
 * @param {Float32Array} chunkAudio
 * @param {number} chunkStart
 * @param {number} chunkIndex
 */
async function processChunk(chunkAudio, chunkStart, chunkIndex) {
  if (!recognizer) throw new Error("ASR model is not initialized");
  if (!chunkAudio.length) {
    return { segments: [], diagnostics: { reason: "empty-chunk" } };
  }
  const startedAt = performance.now();
  const result = await recognizer.transcribe(chunkAudio, chunkStart);
  const words = result.words.map((word) => ({
    ...word,
    utteranceId: chunkIndex,
  }));
  const chunkSeconds = chunkAudio.length / SAMPLE_RATE;
  return {
    segments: wordsToSegments(words, result.text, chunkStart, chunkSeconds),
    diagnostics: {
      wordCount: words.length,
      textLength: result.text.length,
      language: result.language,
      emotion: result.emotion,
      event: result.event,
      utteranceIds: [chunkIndex],
      metrics: {
        inferenceMs: performance.now() - startedAt,
        audioSeconds: chunkSeconds,
      },
    },
  };
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case "init":
      try {
        await init(payload.assetKeys);
        if (!cancelled) self.postMessage({ type: "ready" });
      } catch (err) {
        if (!cancelled) {
          self.postMessage({
            type: "error",
            payload: {
              code: "ASR_INIT_FAILED",
              message: err?.message || String(err),
            },
          });
        }
      }
      break;

    case "process":
      try {
        if (cancelled) return;
        const pcm = new Float32Array(payload.chunkAudio);
        const { segments, diagnostics } = await processChunk(
          pcm,
          payload.chunkStart,
          payload.chunkIndex,
        );
        if (!cancelled) {
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
        }
      } catch (err) {
        if (!cancelled) {
          self.postMessage({
            type: "error",
            payload: {
              code: "ASR_PROCESS_FAILED",
              message: err?.message || String(err),
            },
          });
        }
      }
      break;

    case "cancel":
      cancelled = true;
      initAbortController?.abort();
      await cleanupModel();
      break;
  }
};
