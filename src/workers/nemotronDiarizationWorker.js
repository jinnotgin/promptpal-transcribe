/**
 * Nemotron 3 Diarization worker (up to 8 speakers).
 *
 * Speaks the same request protocol as diarizationWorker.js: `init`,
 * `process-window` for each committed PCM window, then `finalize`. Finalize
 * either assigns speakers to timestamped ASR words (`mode: "words"`) or
 * returns non-overlapping speaker turns for diarize-first ASR
 * (`mode: "turns"`).
 */

// The WebGPU build: the default bundle's WebGPU backend mis-computes these
// graphs (wrong logits in onnxruntime-web 1.30).
import * as ort from "onnxruntime-web/webgpu";
import { getOrDownloadModelAsset } from "@/features/transcription/lib/modelCache.js";
import { MODEL_EXTERNAL_DATA_PATHS } from "@/features/transcription/lib/modelUrls.js";
import { createNemotronDiarizer } from "@/features/transcription/lib/nemotronDiarizer.js";
import {
  dominantSpeakerTurns,
  probabilitiesToSpeakerSegments,
} from "@/features/transcription/lib/diarizationTurns.js";
import {
  configureOrtWasm,
  executionProvidersFor,
} from "@/features/transcription/lib/ortRuntime.js";
import {
  constructSentences,
  initTranscriptProcessingCore,
  prepareWords,
} from "@/features/transcription/lib/transcriptProcessingCore.js";
import {
  flattenSegmentWords,
  normalizeConstructedSegments,
} from "@/features/transcription/lib/transcriptPostProcessing.js";

const HIDDEN_SIZE = 512;
const MEL_BINS = 128;

/** @type {import('onnxruntime-web').InferenceSession | null} */
let session = null;
/** @type {ReturnType<typeof createNemotronDiarizer> | null} */
let diarizer = null;
/** @type {AbortController | null} */
let abortController = null;
let cancelled = false;

self.onmessage = async (event) => {
  const { type, payload, requestId } = event.data;
  try {
    switch (type) {
      case "init":
        await initialize(payload.runtime || "wasm");
        reply("ready", requestId, {});
        break;
      case "process-window": {
        if (!diarizer) throw new Error("Nemotron diarizer is not initialized");
        await diarizer.pushPcm(new Float32Array(payload.pcmBuffer));
        const total = Math.max(1, Number(payload.totalWindows || 1));
        postProgress(((Number(payload.windowIndex || 0) + 1) / total) * 100);
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
    console.error(`[nemotron-worker][${type}]`, error);
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

/** @param {'webgpu' | 'wasm'} runtime */
async function initialize(runtime) {
  cancelled = false;
  abortController = new AbortController();
  if (!session) {
    configureOrtWasm(ort);
    const onProgress = (progress) =>
      self.postMessage({ type: "model-progress", payload: progress });
    const [model, data] = await Promise.all([
      getOrDownloadModelAsset(
        "nemotronInt8",
        abortController.signal,
        onProgress,
      ),
      getOrDownloadModelAsset(
        "nemotronInt8Data",
        abortController.signal,
        onProgress,
      ),
    ]);
    session = await ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: executionProvidersFor(runtime),
      graphOptimizationLevel: "all",
      externalData: [
        {
          path: MODEL_EXTERNAL_DATA_PATHS.nemotronInt8Data,
          data: new Uint8Array(data),
        },
      ],
    });
  }
  diarizer = createNemotronDiarizer({ runStep });
}

/** @param {import('@/features/transcription/lib/nemotronDiarizer.js').NemotronStepInput} input */
async function runStep({
  inputFeatures,
  melFrames,
  cachedEmbeds,
  cachedFrames,
  attentionMask,
}) {
  if (!session) throw new Error("Nemotron session is not initialized");
  const feeds = {
    input_features: new ort.Tensor("float32", inputFeatures, [
      1,
      melFrames,
      MEL_BINS,
    ]),
    cached_embeds: new ort.Tensor("float32", cachedEmbeds, [
      1,
      cachedFrames,
      HIDDEN_SIZE,
    ]),
    attention_mask: new ort.Tensor("int64", attentionMask, [
      1,
      attentionMask.length,
    ]),
  };
  const outputs = await session.run(feeds);
  try {
    return {
      logits: Float32Array.from(
        /** @type {Float32Array} */ (outputs.logits.data),
      ),
      chunkEmbeds: Float32Array.from(
        /** @type {Float32Array} */ (outputs.chunk_embeds.data),
      ),
      silenceEmbeds: Float32Array.from(
        /** @type {Float32Array} */ (outputs.silence_embeds.data),
      ),
    };
  } finally {
    Object.values(feeds).forEach((tensor) => tensor.dispose?.());
    Object.values(outputs).forEach((tensor) => tensor.dispose?.());
  }
}

/**
 * @param {{ segments?: import('@/features/transcription/lib/transcriptionDb.js').TranscriptSegment[], mode?: 'words' | 'turns' }} payload
 */
async function finalize(payload) {
  if (!diarizer) throw new Error("Nemotron diarizer is not initialized");
  await diarizer.finish();
  const probabilities = diarizer.getProbabilities();
  diarizer = null;
  const speakerSegments = probabilitiesToSpeakerSegments(probabilities);

  if (payload.mode === "turns") {
    return {
      turns: dominantSpeakerTurns(probabilities),
      diagnostics: diagnosticsFor(speakerSegments, probabilities.frames),
    };
  }

  const segments = payload.segments || [];
  const words = flattenSegmentWords(segments);
  if (!words.length) {
    return {
      segments,
      diagnostics: diagnosticsFor(speakerSegments, probabilities.frames),
    };
  }
  await initTranscriptProcessingCore(
    "/wasm/transcript-processing-core_bg.wasm",
  );
  const constructed = normalizeConstructedSegments(
    constructSentences(prepareWords(words), speakerSegments, false),
  );
  return {
    segments: constructed.length ? constructed : segments,
    diagnostics: diagnosticsFor(speakerSegments, probabilities.frames),
  };
}

/**
 * @param {Array<{ id: number }>} speakerSegments
 * @param {number} frames
 */
function diagnosticsFor(speakerSegments, frames) {
  return {
    engine: "nemotron",
    frames,
    labelCount: speakerSegments.length,
    speakerCount: new Set(speakerSegments.map((segment) => segment.id)).size,
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
