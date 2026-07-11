import { v4 as uuidv4 } from "uuid";
import {
  splitIntoChunks,
  extractChunkAudio,
} from "@/features/transcription/lib/chunkingStrategy.js";
import {
  rebuildSegmentsFromWords,
  mergeAdjacentSegments,
  stitchSegments,
} from "@/features/transcription/lib/timestampStitching.js";
import { constructTranscriptSegments } from "@/features/transcription/lib/transcriptPostProcessing.js";

const ENABLE_TRANSCRIPTION_DIAGNOSTICS = import.meta.env.DEV;

/**
 * Composable that runs ASR inference in a dedicated worker.
 * Sends chunks sequentially to the worker and collects results.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useAsrInference(store) {
  /** @type {Worker | null} */
  let worker = null;
  /** @type {Array<Record<string, unknown>>} */
  let asrDiagnostics = [];

  /**
   * Initialize the ASR worker, downloading and loading model files.
   * The pipeline is responsible for setting `processPhase` before/after this
   * call; this function only updates `parakeetLoadProgress` so phase does not
   * jump backwards once transcription has started.
   * @param {'webgpu' | 'wasm'} runtime
   * @returns {Promise<void>}
   */
  function initialize(runtime) {
    return new Promise((resolve, reject) => {
      worker = new Worker(new URL("@/workers/asrWorker.js", import.meta.url), {
        type: "module",
      });
      const assetProgress = new Map();

      const onMessage = (e) => {
        const { type, payload } = e.data;
        if (type === "ready") {
          worker?.removeEventListener("message", onMessage);
          store.parakeetLoadProgress = 100;
          store.parakeetLoadIndeterminate = false;
          resolve();
        } else if (type === "model-progress") {
          if (payload.source === "cache") {
            store.processPhase = "loading-model";
            store.parakeetLoadIndeterminate = false;
            return;
          } else if (payload.source === "download") {
            store.processPhase = "downloading-model";
          }
          if (payload.percent == null) {
            store.parakeetLoadIndeterminate = true;
            return;
          }
          store.parakeetLoadIndeterminate = false;
          assetProgress.set(payload.assetKey, payload.percent);
          const values = Array.from(assetProgress.values());
          store.parakeetLoadProgress =
            values.reduce((sum, value) => sum + value, 0) / values.length;
          store.updateProgress("transcription", store.parakeetLoadProgress);
        } else if (type === "model-loading") {
          store.processPhase = "loading-model";
          store.parakeetLoadProgress = payload.percent;
          store.updateProgress("transcription", payload.percent);
        } else if (type === "error") {
          worker?.removeEventListener("message", onMessage);
          reject(new Error(payload.message));
        }
      };
      worker.addEventListener("message", onMessage);

      worker.onerror = (err) => {
        reject(new Error(`ASR worker init error: ${err.message}`));
      };

      worker.postMessage({
        type: "init",
        payload: {
          runtime,
          assetKeys: {
            encoder: runtime === "webgpu" ? "encoderFp16" : "encoderInt8",
            decoder: "decoder",
            vocab: "vocab",
          },
        },
      });
    });
  }

  /**
   * Process a single chunk through the worker.
   * @param {Float32Array} chunkAudio
   * @param {number} chunkStart
   * @param {number} chunkIndex
   * @param {number} totalChunks
   * @returns {Promise<import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]>}
   */
  function processChunk(chunkAudio, chunkStart, chunkIndex, totalChunks) {
    return new Promise((resolve, reject) => {
      const onMessage = (e) => {
        const { type, payload } = e.data;
        switch (type) {
          case "diagnostics":
            asrDiagnostics.push(payload);
            logAsrDiagnostics(payload);
            break;
          case "progress":
            store.updateProgress("transcription", payload.percent);
            break;
          case "partial":
            worker.removeEventListener("message", onMessage);
            // Assign IDs and null speaker to raw segments
            const segments = payload.segments.map((seg) => ({
              id: uuidv4(),
              text: seg.text,
              start: seg.start,
              end: seg.end,
              words: seg.words,
              speaker: null,
            }));
            resolve(segments);
            break;
          case "error":
            worker.removeEventListener("message", onMessage);
            reject(new Error(payload.message));
            break;
        }
      };
      worker.addEventListener("message", onMessage);

      const buffer = chunkAudio.buffer;
      worker.postMessage(
        {
          type: "process",
          payload: {
            chunkAudio: buffer,
            chunkStart,
            chunkIndex,
            totalChunks,
          },
        },
        [buffer],
      );
    });
  }

  /**
   * Run ASR on all speech regions. The worker must already be initialized.
   * @param {Float32Array} pcm - Full 16kHz mono audio
   * @param {Array<{ start: number, end: number }>} speechRegions
   * @returns {Promise<import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]>}
   */
  async function transcribeChunks(pcm, speechRegions) {
    if (!worker) {
      throw new Error(
        "ASR worker is not initialized; call initialize() first.",
      );
    }
    try {
      asrDiagnostics = [];

      // Split regions into processable chunks
      const chunks = splitIntoChunks(speechRegions, {
        audioDuration: pcm.length / 16000,
      });

      // Process chunks sequentially
      /** @type {Array<{ chunk: import('@/features/transcription/lib/chunkingStrategy').AsrChunk, segments: import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[] }>} */
      const chunkResults = [];

      for (let i = 0; i < chunks.length; i++) {
        if (store.isCancelled) {
          throw new DOMException("Aborted", "AbortError");
        }

        const chunk = chunks[i];
        const audio = extractChunkAudio(pcm, chunk);
        const segments = await processChunk(
          audio,
          chunk.start,
          i,
          chunks.length,
        );

        chunkResults.push({ chunk, segments });

        // Stream partial results to store
        const allSoFar = mergeTranscriptRows(stitchSegments(chunkResults));
        store.setSegments(allSoFar);
      }

      // Final stitched result. If diarization is enabled, keep raw ASR
      // words for the speaker-aware sentence constructor pass.
      const finalRows = mergeTranscriptRows(stitchSegments(chunkResults));
      logAsrSummary(finalRows, asrDiagnostics);
      if (store.enableDiarization) return finalRows;
      return await constructTranscriptSegments(finalRows, {
        skipDiarize: true,
      });
    } finally {
      cleanup();
    }
  }

  function cleanup() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  function abort() {
    if (worker) {
      worker.postMessage({ type: "cancel" });
      cleanup();
    }
  }

  return { initialize, transcribeChunks, processChunk, cleanup, abort };
}

/**
 * The reference pipeline keeps ASR word output as a readable transcript stream instead
 * of exposing every short model utterance as a separate row. Merge close
 * adjacent rows after overlap stitching; diarization can still split speakers
 * later when it has better evidence.
 *
 * @param {import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]} segments
 */
function mergeTranscriptRows(segments) {
  return mergeAdjacentSegments(rebuildSegmentsFromWords(segments), 1.25);
}

/**
 * @param {Record<string, unknown>} diagnostics
 */
function logAsrDiagnostics(diagnostics) {
  if (!ENABLE_TRANSCRIPTION_DIAGNOSTICS || typeof console === "undefined")
    return;
  console.info("[transcription][asr-chunk]", {
    chunkIndex: diagnostics.chunkIndex,
    chunkStart: diagnostics.chunkStart,
    wordCount: diagnostics.wordCount,
    textLength: diagnostics.textLength,
    utteranceIds: diagnostics.utteranceIds,
    wordPreview: diagnostics.wordPreview,
    utteranceTextPreview: diagnostics.utteranceTextPreview,
    metrics: diagnostics.metrics,
  });
}

/**
 * @param {import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]} finalRows
 * @param {Array<Record<string, unknown>>} diagnostics
 */
function logAsrSummary(finalRows, diagnostics) {
  if (!ENABLE_TRANSCRIPTION_DIAGNOSTICS || typeof console === "undefined")
    return;
  const words = finalRows.flatMap((segment) => segment.words || []);
  const utteranceIds = Array.from(
    new Set(
      words
        .map((word) => Number(word.utteranceId))
        .filter((id) => Number.isFinite(id)),
    ),
  );
  console.info("[transcription][asr-summary]", {
    chunkCount: diagnostics.length,
    rowCount: finalRows.length,
    wordCount: words.length,
    utteranceIds,
    wordPreview: words
      .slice(0, 48)
      .map((word) => word.text)
      .join(" "),
  });
}
