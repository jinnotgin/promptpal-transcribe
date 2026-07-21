/**
 * ASR inference worker.
 *
 * Transcription delegates Parakeet TDT inference to parakeet.js, matching the
 * reference pipeline shape: fromUrls(...), webgpu-hybrid/wasm backend, JS
 * preprocessor, and timestamped transcribe() output.
 */

import { fromUrls } from "parakeet.js";
import { getOrDownloadModelAsset } from "@/features/transcription/lib/modelCache.js";

const SAMPLE_RATE = 16000;

/** @type {import('parakeet.js').ParakeetModel | null} */
let parakeetModel = null;
/** @type {string[]} */
let modelObjectUrls = [];
let cancelled = false;
/** @type {AbortController | null} */
let initAbortController = null;

/**
 * @param {'webgpu' | 'wasm'} runtime
 * @param {{ encoder: string, decoder: string, vocab: string }} assetKeys
 */
async function init(runtime, assetKeys) {
  cancelled = false;
  initAbortController = new AbortController();
  const signal = initAbortController.signal;
  const progress = (payload) => {
    self.postMessage({ type: "model-progress", payload });
  };

  const [encoderBuffer, decoderBuffer, vocabBuffer] = await Promise.all([
    getOrDownloadModelAsset(assetKeys.encoder, signal, progress),
    getOrDownloadModelAsset(assetKeys.decoder, signal, progress),
    getOrDownloadModelAsset(assetKeys.vocab, signal, progress),
  ]);

  if (cancelled || signal.aborted)
    throw new DOMException("Aborted", "AbortError");

  self.postMessage({ type: "model-loading", payload: { percent: 20 } });
  const encoderUrl = createObjectUrl(encoderBuffer, "application/octet-stream");
  const decoderUrl = createObjectUrl(decoderBuffer, "application/octet-stream");
  const tokenizerUrl = createObjectUrl(vocabBuffer, "text/plain");

  self.postMessage({ type: "model-loading", payload: { percent: 45 } });
  parakeetModel = await fromUrls({
    encoderUrl,
    decoderUrl,
    tokenizerUrl,
    backend: runtime === "webgpu" ? "webgpu-hybrid" : "wasm",
    preprocessorBackend: "js",
    enableProfiling: false,
    enableGraphCapture: false,
  });

  self.postMessage({ type: "model-loading", payload: { percent: 100 } });
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} type
 */
function createObjectUrl(buffer, type) {
  const url = URL.createObjectURL(new Blob([buffer], { type }));
  modelObjectUrls.push(url);
  return url;
}

async function cleanupModel() {
  const model = parakeetModel;
  parakeetModel = null;
  const disposableModel =
    /** @type {{ dispose?: () => Promise<void> | void } | null} */ (model);
  if (disposableModel && typeof disposableModel.dispose === "function") {
    try {
      await disposableModel.dispose();
    } catch {
      // Worker termination is still sufficient cleanup if dispose fails.
    }
  }
  for (const url of modelObjectUrls) {
    URL.revokeObjectURL(url);
  }
  modelObjectUrls = [];
}

/**
 * @param {Float32Array} chunkAudio
 * @param {number} chunkStart
 * @param {number} chunkIndex
 */
async function processChunk(chunkAudio, chunkStart, chunkIndex) {
  if (!parakeetModel) throw new Error("ASR model is not initialized");
  if (!chunkAudio.length) {
    return {
      segments: [],
      diagnostics: { reason: "empty-chunk" },
    };
  }

  const result = await parakeetModel.transcribe(chunkAudio, SAMPLE_RATE, {
    returnTimestamps: true,
    returnConfidences: false,
    enableProfiling: false,
  });

  const words = normalizeParakeetWords(
    result.words || [],
    chunkIndex,
    chunkStart,
  );
  const rawText = result.utterance_text || "";
  return {
    segments: wordsToSegments(
      words,
      rawText,
      chunkStart,
      chunkAudio.length / SAMPLE_RATE,
    ),
    diagnostics: {
      wordCount: words.length,
      textLength: rawText.length,
      utteranceIds: Array.from(
        new Set(words.map((word) => word.utteranceId)),
      ).filter((id) => id != null),
      metrics: result.metrics || null,
    },
  };
}

/**
 * @param {Array<{ text?: string, start_time?: number, end_time?: number, start?: number, end?: number, confidence?: number }>} words
 * @param {number} utteranceId
 * @param {number} chunkStart
 * @returns {Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }>}
 */
function normalizeParakeetWords(words, utteranceId, chunkStart) {
  const normalized = [];
  for (const word of words) {
    const text = String(word.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const relativeStart = Number(word.start_time ?? word.start);
    const relativeEnd = Number(word.end_time ?? word.end);
    const start = relativeStart + chunkStart;
    const end = relativeEnd + chunkStart;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    normalized.push({
      text,
      start: roundTime(Math.max(0, start)),
      end: roundTime(Math.max(start, end)),
      confidence: Number.isFinite(word.confidence)
        ? word.confidence
        : undefined,
      utteranceId,
    });
  }
  return dedupeDecodedWords(normalized);
}

/**
 * @param {Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }>} words
 * @param {string} fallbackText
 * @param {number} chunkStart
 * @param {number} chunkDuration
 */
function wordsToSegments(words, fallbackText, chunkStart, chunkDuration) {
  if (!words.length) {
    const text = fallbackText.replace(/\s+/g, " ").trim();
    return text
      ? [
          {
            text,
            start: roundTime(chunkStart),
            end: roundTime(chunkStart + chunkDuration),
            words: [],
          },
        ]
      : [];
  }

  const segments = [];
  let current = null;
  for (const word of words) {
    const shouldStartNew =
      !current ||
      current.words.length >= 16 ||
      word.start - current.end > 0.9 ||
      word.end - current.start > 8;
    if (shouldStartNew) {
      if (current) segments.push(finalizeSegment(current));
      current = { words: [word], start: word.start, end: word.end };
    } else {
      current.words.push(word);
      current.end = word.end;
    }
  }
  if (current) segments.push(finalizeSegment(current));
  return segments;
}

/**
 * @param {{ words: Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }>, start: number, end: number }} segment
 */
function finalizeSegment(segment) {
  return {
    text: segment.words.map((word) => word.text).join(" "),
    start: roundTime(segment.start),
    end: roundTime(segment.end),
    words: segment.words.map((word) => ({
      text: word.text,
      start: roundTime(word.start),
      end: roundTime(word.end),
      confidence: word.confidence,
      utteranceId: word.utteranceId,
    })),
  };
}

/**
 * @param {number} value
 */
function roundTime(value) {
  return Math.round(value * 100) / 100;
}

/**
 * @param {Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }>} words
 */
function dedupeDecodedWords(words) {
  const cleaned = [];
  for (const word of words) {
    const normalized = normalizeWord(word.text);
    const previous = cleaned[cleaned.length - 1];
    if (previous && normalizeWord(previous.text) === normalized) {
      const startDelta = Math.abs(word.start - previous.start);
      const overlap =
        Math.min(previous.end, word.end) - Math.max(previous.start, word.start);
      const minDuration = Math.max(
        0.01,
        Math.min(previous.end - previous.start, word.end - word.start),
      );
      if (startDelta <= 0.25 || overlap / minDuration >= 0.5) {
        previous.end = Math.max(previous.end, word.end);
        if (word.confidence != null) previous.confidence = word.confidence;
        continue;
      }
    }
    cleaned.push(word);
  }
  return cleaned;
}

/**
 * @param {string} text
 */
function normalizeWord(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case "init":
      try {
        await init(payload.runtime, payload.assetKeys);
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
          if (diagnostics) {
            self.postMessage({
              type: "diagnostics",
              payload: {
                ...diagnostics,
                chunkIndex: payload.chunkIndex,
                chunkStart: payload.chunkStart,
              },
            });
          }
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
