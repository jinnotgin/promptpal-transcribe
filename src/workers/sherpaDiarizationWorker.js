/**
 * Large-group speaker diarization worker (sherpa-onnx pipeline: pyannote
 * segmentation, CAM++ speaker embeddings, clustering into a given count).
 *
 * Speaks the same request protocol as nemotronDiarizationWorker.js: `init`,
 * `process-window` for each committed PCM window, then `finalize` with
 * `mode: "words"` (assign speakers to timestamped ASR words) or
 * `mode: "turns"` (non-overlapping turns for diarize-first ASR).
 */

// Both models run on WASM (see initialize), so the default bundle suffices.
import * as ort from "onnxruntime-web";
import { getOrDownloadModelAsset } from "@/features/transcription/lib/modelCache.js";
import { createSherpaDiarizer } from "@/features/transcription/lib/sherpaDiarizer.js";
import {
  dominantSpeakerTurns,
  probabilitiesToSpeakerSegments,
  segmentsToProbabilities,
} from "@/features/transcription/lib/diarizationTurns.js";
import { configureOrtWasm } from "@/features/transcription/lib/ortRuntime.js";
import {
  constructSentences,
  initTranscriptProcessingCore,
  prepareWords,
} from "@/features/transcription/lib/transcriptProcessingCore.js";
import {
  flattenSegmentWords,
  normalizeConstructedSegments,
} from "@/features/transcription/lib/transcriptPostProcessing.js";

const FBANK_BINS = 80;

/** @type {import('onnxruntime-web').InferenceSession | null} */
let segmentationSession = null;
/** @type {import('onnxruntime-web').InferenceSession | null} */
let embeddingSession = null;
/** @type {ReturnType<typeof createSherpaDiarizer> | null} */
let diarizer = null;
/** @type {AbortController | null} */
let abortController = null;
let cancelled = false;
let numSpeakers = 0;
let processedSeconds = 0;
/** @type {(seconds: number) => void} */
let onChunkProgress = () => {};

self.onmessage = async (event) => {
  const { type, payload, requestId } = event.data;
  try {
    switch (type) {
      case "init":
        await initialize(payload.numSpeakers);
        reply("ready", requestId, {});
        break;
      case "process-window": {
        if (!diarizer) throw new Error("Sherpa diarizer is not initialized");
        const pcm = new Float32Array(payload.pcmBuffer);
        const total = Math.max(1, Number(payload.totalWindows || 1));
        const index = Number(payload.windowIndex || 0);
        // Report within the window too: embeddings make each window slow.
        const windowSeconds = pcm.length / 16000;
        const before = processedSeconds;
        onChunkProgress = (seconds) =>
          postProgress(
            ((index + Math.min(1, (seconds - before) / windowSeconds)) /
              total) *
              100,
          );
        await diarizer.pushPcm(pcm);
        processedSeconds += windowSeconds;
        postProgress(((index + 1) / total) * 100);
        reply("window-complete", requestId, {});
        break;
      }
      case "finalize":
        reply("complete", requestId, await finalize(payload));
        break;
      case "cancel":
        cancelled = true;
        abortController?.abort();
        diarizer = null;
        break;
    }
  } catch (error) {
    if (cancelled) return;
    console.error(`[sherpa-worker][${type}]`, error);
    self.postMessage({
      type: "error",
      requestId,
      payload: {
        code: "DIARIZATION_FAILED",
        message: `Diarization ${type} failed: ${error?.message || String(error)}`,
      },
    });
  }
};

/** @param {number} speakers */
async function initialize(speakers) {
  cancelled = false;
  numSpeakers = Math.max(1, Math.round(Number(speakers) || 0));
  abortController = new AbortController();
  if (!segmentationSession || !embeddingSession) {
    configureOrtWasm(ort);
    const onProgress = (progress) =>
      self.postMessage({ type: "model-progress", payload: progress });
    const [segmentation, embedding] = await Promise.all([
      getOrDownloadModelAsset(
        "sherpaSegmentation",
        abortController.signal,
        onProgress,
      ),
      getOrDownloadModelAsset(
        "sherpaEmbedding",
        abortController.signal,
        onProgress,
      ),
    ]);
    // Both run on WASM: segmentation is LSTM-based and tiny, and CAM++ on
    // the WebGPU backend drifts to ~0.91 cosine from the WASM/PyTorch
    // embedding (onnxruntime-web 1.30), which merges similar voices.
    segmentationSession = await ort.InferenceSession.create(
      new Uint8Array(segmentation),
      { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
    );
    embeddingSession = await ort.InferenceSession.create(
      new Uint8Array(embedding),
      { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
    );
  }
  processedSeconds = 0;
  diarizer = createSherpaDiarizer({
    runSegmentation,
    runEmbedding,
    numClusters: numSpeakers,
    onChunk: (seconds) => onChunkProgress(seconds),
  });
}

/** @param {Float32Array} chunk */
async function runSegmentation(chunk) {
  if (!segmentationSession) throw new Error("Segmentation is not loaded");
  const input = new ort.Tensor("float32", chunk, [1, 1, chunk.length]);
  const outputs = await segmentationSession.run({ x: input });
  try {
    return {
      logits: Float32Array.from(/** @type {Float32Array} */ (outputs.y.data)),
      frames: Number(outputs.y.dims[1]),
    };
  } finally {
    input.dispose?.();
    Object.values(outputs).forEach((tensor) => tensor.dispose?.());
  }
}

/**
 * @param {Float32Array} features
 * @param {number} frames
 */
async function runEmbedding(features, frames) {
  if (!embeddingSession) throw new Error("Speaker embedding is not loaded");
  const input = new ort.Tensor("float32", features, [1, frames, FBANK_BINS]);
  const outputs = await embeddingSession.run({ x: input });
  try {
    return Float32Array.from(
      /** @type {Float32Array} */ (outputs.embedding.data),
    );
  } finally {
    input.dispose?.();
    Object.values(outputs).forEach((tensor) => tensor.dispose?.());
  }
}

/**
 * @param {{ segments?: import('@/features/transcription/lib/transcriptionDb.js').TranscriptSegment[], mode?: 'words' | 'turns' }} payload
 */
async function finalize(payload) {
  if (!diarizer) throw new Error("Sherpa diarizer is not initialized");
  const embeddings = diarizer.embeddingCount;
  const sherpaSegments = await diarizer.finish();
  diarizer = null;
  const grid = segmentsToProbabilities(sherpaSegments);
  const speakerSegments = probabilitiesToSpeakerSegments(grid);
  const diagnostics = {
    engine: "sherpa",
    requestedSpeakers: numSpeakers,
    embeddings,
    labelCount: speakerSegments.length,
    speakerCount: new Set(speakerSegments.map((segment) => segment.id)).size,
  };

  if (payload.mode === "turns") {
    return { turns: dominantSpeakerTurns(grid), diagnostics };
  }

  const segments = payload.segments || [];
  const words = flattenSegmentWords(segments);
  if (!words.length) return { segments, diagnostics };
  await initTranscriptProcessingCore(
    "/wasm/transcript-processing-core_bg.wasm",
  );
  const constructed = normalizeConstructedSegments(
    constructSentences(prepareWords(words), speakerSegments, false),
  );
  return {
    segments: constructed.length ? constructed : segments,
    diagnostics,
  };
}

/** @param {number} percent */
function postProgress(percent) {
  if (!cancelled) self.postMessage({ type: "progress", payload: { percent } });
}

/**
 * @param {string} type
 * @param {number | undefined} requestId
 * @param {unknown} payload
 */
function reply(type, requestId, payload) {
  if (!cancelled) self.postMessage({ type, requestId, payload });
}
