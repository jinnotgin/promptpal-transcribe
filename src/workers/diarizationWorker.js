// NOTE: heavy modules (onnxruntime-web, transcript processing glue) are loaded
// dynamically inside ensureModulesLoaded() so we can surface a real error if
// the worker's top-level evaluation would otherwise fail silently.
const ENABLE_TRANSCRIPTION_DIAGNOSTICS = import.meta.env.DEV;
if (ENABLE_TRANSCRIPTION_DIAGNOSTICS) {
  console.log("[diarization-worker] module evaluating");
}

/** @type {typeof import('onnxruntime-web') | null} */
let ort = null;
/** @type {typeof import('@/features/transcription/lib/modelCache.js').getOrDownloadModelAsset | null} */
let getOrDownloadModelAsset = null;
/** @type {typeof import('@/features/transcription/lib/transcriptProcessingCore.js') | null} */
let transcriptProcessingCore = null;
/** @type {typeof import('@/features/transcription/lib/transcriptPostProcessing.js') | null} */
let postProcessing = null;

async function ensureModulesLoaded() {
  if (
    ort &&
    getOrDownloadModelAsset &&
    transcriptProcessingCore &&
    postProcessing
  )
    return;

  const tryImport = async (label, loader) => {
    try {
      if (ENABLE_TRANSCRIPTION_DIAGNOSTICS) {
        console.log(`[diarization-worker] importing ${label}`);
      }
      const mod = await loader();
      if (ENABLE_TRANSCRIPTION_DIAGNOSTICS) {
        console.log(`[diarization-worker] imported ${label}`);
      }
      return mod;
    } catch (err) {
      console.error(`[diarization-worker] failed importing ${label}`, err);
      const wrapped = err instanceof Error ? err : new Error(String(err));
      wrapped.message = `[import:${label}] ${wrapped.message}`;
      throw wrapped;
    }
  };

  if (!ort) {
    ort = /** @type {typeof import('onnxruntime-web')} */ (
      await tryImport("onnxruntime-web", () => import("onnxruntime-web"))
    );
  }
  if (!getOrDownloadModelAsset) {
    const mod = await tryImport(
      "modelCache",
      () => import("@/features/transcription/lib/modelCache.js"),
    );
    getOrDownloadModelAsset = mod.getOrDownloadModelAsset;
  }
  if (!transcriptProcessingCore) {
    transcriptProcessingCore = await tryImport(
      "transcriptProcessingCore",
      () => import("@/features/transcription/lib/transcriptProcessingCore.js"),
    );
  }
  if (!postProcessing) {
    postProcessing = await tryImport(
      "transcriptPostProcessing",
      () => import("@/features/transcription/lib/transcriptPostProcessing.js"),
    );
  }
}

const postWorkerError = (code, err) => {
  if (typeof console !== "undefined") {
    console.error(`[diarization-worker][${code}]`, err);
  }
  if (!cancelled) {
    self.postMessage({
      type: "error",
      payload: {
        code,
        message: describeError(err),
      },
    });
  }
};

self.addEventListener("error", (event) => {
  if (typeof console !== "undefined") {
    console.error("[diarization-worker][global-error]", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
    });
  }
  postWorkerError(
    "DIARIZATION_WORKER_ERROR",
    event.error ||
      event.message ||
      `${event.filename || "worker"}:${event.lineno || 0}:${event.colno || 0}`,
  );
});

self.addEventListener("unhandledrejection", (event) => {
  if (typeof console !== "undefined") {
    console.error("[diarization-worker][unhandled-rejection]", event.reason);
  }
  postWorkerError(
    "DIARIZATION_UNHANDLED_REJECTION",
    event.reason || "Unhandled worker rejection",
  );
});

let cancelled = false;
/** @type {import('onnxruntime-web').InferenceSession | null} */
let sortformerSession = null;
/** @type {AbortController | null} */
let abortController = null;

const SAMPLE_RATE = 16000;
const MEL_FEATURE_DIM = 128;
const MEL_CHUNK_SAMPLES = 4_800_000;
const MAX_DIARIZE_FRAMES = 2720;
const SORTFORMER_HIDDEN = 512;
const PADDED_BATCH_FLOATS = MAX_DIARIZE_FRAMES * MEL_FEATURE_DIM;

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case "process":
      try {
        cancelled = false;
        abortController = new AbortController();
        await runStage("ensure-modules-loaded", () => ensureModulesLoaded());
        await runStage("init-transcript-processing-core", () =>
          transcriptProcessingCore.initTranscriptProcessingCore(
            "/wasm/transcript-processing-core_bg.wasm",
          ),
        );
        await runStage("load-sortformer", () =>
          loadSortformer(payload.runtime || "wasm", abortController.signal),
        );

        const pcm = new Float32Array(payload.pcmBuffer);
        const segments = payload.segments || [];
        const diarizationLabels = await runStage("diarize-pcm", () =>
          diarizePcm(pcm, (percent) => {
            if (!cancelled) {
              self.postMessage({ type: "progress", payload: { percent } });
            }
          }),
        );

        if (cancelled) return;

        const words = postProcessing.flattenSegmentWords(segments);
        const constructed = words.length
          ? await runStage("construct-sentences", () =>
              transcriptProcessingCore.constructSentences(
                transcriptProcessingCore.prepareWords(words),
                diarizationLabels,
                false,
              ),
            )
          : [];
        const constructedSegments =
          postProcessing.normalizeConstructedSegments(constructed);
        const inputUtteranceIds = Array.from(
          new Set(
            words
              .map((word) => Number(word.utteranceId))
              .filter((id) => Number.isFinite(id)),
          ),
        );
        const outputSpeakers = Array.from(
          new Set(
            constructedSegments
              .map((segment) => segment.speaker)
              .filter(Boolean),
          ),
        );

        self.postMessage({
          type: "complete",
          payload: {
            segments: constructedSegments.length
              ? constructedSegments
              : segments,
            diagnostics: {
              labelCount: diarizationLabels?.length ?? 0,
              inputWordCount: words.length,
              inputUtteranceIds,
              inputSegmentCount: segments.length,
              outputSegmentCount: constructedSegments.length,
              outputSpeakers,
              outputPreview: constructedSegments.slice(0, 8).map((segment) => ({
                start: segment.start,
                end: segment.end,
                speaker: segment.speaker,
                text: segment.text.slice(0, 120),
              })),
            },
          },
        });
      } catch (err) {
        postWorkerError("DIARIZATION_FAILED", err);
      }
      break;

    case "cancel":
      cancelled = true;
      abortController?.abort();
      break;
  }
};

/**
 * @param {'webgpu' | 'wasm'} runtime
 * @param {AbortSignal} signal
 */
async function loadSortformer(runtime, signal) {
  if (sortformerSession) return;
  configureOrt();
  const modelBuffer = await getOrDownloadModelAsset(
    "diarization",
    signal,
    (progress) => {
      self.postMessage({ type: "model-progress", payload: progress });
    },
  );
  const providers = runtime === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
  sortformerSession = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: providers,
    graphOptimizationLevel: "all",
  });
}

function configureOrt() {
  const env = /** @type {any} */ (ort).env;
  const version = env?.versions?.common || "1.24.3";
  if (env?.wasm && !env.wasm.wasmPaths) {
    env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
  }
  if (env?.wasm) {
    env.wasm.numThreads =
      typeof SharedArrayBuffer === "undefined"
        ? 1
        : Math.max(1, (navigator.hardwareConcurrency || 4) - 2);
    env.wasm.proxy = false;
  }
}

/**
 * @param {Float32Array} pcm
 * @param {(percent: number) => void} onProgress
 */
async function diarizePcm(pcm, onProgress) {
  if (!sortformerSession)
    throw new Error("Sortformer session is not initialized");
  const processor = new transcriptProcessingCore.SortformerProcessor();
  const melChunks = [];
  let totalFrames = 0;

  try {
    for (
      let start = 0;
      start < pcm.length && !cancelled;
      start += MEL_CHUNK_SAMPLES
    ) {
      const window = pcm.slice(
        start,
        Math.min(pcm.length, start + MEL_CHUNK_SAMPLES),
      );
      const mel = transcriptProcessingCore.computeMelSpectrogram(window);
      if (mel.length) {
        melChunks.push(mel);
        totalFrames += mel.length / MEL_FEATURE_DIM;
      }
    }

    if (!totalFrames) return new Float32Array(0);

    const totalBatches = Math.ceil(totalFrames / MAX_DIARIZE_FRAMES);
    const batchResults = [];

    for (
      let batchIndex = 0;
      batchIndex < totalBatches && !cancelled;
      batchIndex++
    ) {
      const frameOffset = batchIndex * MAX_DIARIZE_FRAMES;
      const framesInBatch = Math.min(
        MAX_DIARIZE_FRAMES,
        totalFrames - frameOffset,
      );
      let batchFeatures = extractMelFrames(
        melChunks,
        frameOffset,
        framesInBatch,
      );
      let feedFrames = framesInBatch;

      if (framesInBatch < MAX_DIARIZE_FRAMES) {
        const padded = new Float32Array(PADDED_BATCH_FLOATS);
        padded.set(batchFeatures);
        batchFeatures = padded;
        feedFrames = MAX_DIARIZE_FRAMES;
      }

      const chunkPredictions = await processSortformerBatch(
        processor,
        batchFeatures,
        feedFrames,
        framesInBatch,
      );
      batchResults.push(chunkPredictions);
      onProgress(((batchIndex + 1) / totalBatches) * 100);
    }

    const totalPredictionRows = batchResults.reduce(
      (sum, result) => sum + result.length / 4,
      0,
    );
    const allPredictions = new Float32Array(totalPredictionRows * 4);
    let offset = 0;
    for (const result of batchResults) {
      allPredictions.set(result, offset);
      offset += result.length;
    }
    return processor.finalizeAssignment(allPredictions);
  } finally {
    processor.free();
  }
}

/**
 * @param {Float32Array[]} melChunks
 * @param {number} frameOffset
 * @param {number} frameCount
 */
function extractMelFrames(melChunks, frameOffset, frameCount) {
  const batch = new Float32Array(frameCount * MEL_FEATURE_DIM);
  let remainingOffset = frameOffset * MEL_FEATURE_DIM;
  let writeOffset = 0;

  for (const chunk of melChunks) {
    if (remainingOffset >= chunk.length) {
      remainingOffset -= chunk.length;
      continue;
    }
    const readable = Math.min(
      chunk.length - remainingOffset,
      batch.length - writeOffset,
    );
    batch.set(
      chunk.subarray(remainingOffset, remainingOffset + readable),
      writeOffset,
    );
    writeOffset += readable;
    remainingOffset = 0;
    if (writeOffset >= batch.length) break;
  }

  return batch;
}

/**
 * @param {InstanceType<NonNullable<typeof transcriptProcessingCore>['SortformerProcessor']>} processor
 * @param {Float32Array} melFeatures
 * @param {number} numFrames
 * @param {number} actualFrameCount
 */
async function processSortformerBatch(
  processor,
  melFeatures,
  numFrames,
  actualFrameCount,
) {
  if (!sortformerSession)
    throw new Error("Sortformer session is not initialized");
  const speakerCache = processor.getSpeakerCache();
  const speakerCacheLength = processor.getSpeakerCacheLength();
  const fifo = processor.getFifo();
  const fifoLength = processor.getFifoLength();

  const inputs = {
    chunk: new ort.Tensor("float32", melFeatures, [
      1,
      numFrames,
      MEL_FEATURE_DIM,
    ]),
    chunk_lengths: new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(actualFrameCount)]),
      [1],
    ),
    spkcache: new ort.Tensor(
      "float32",
      speakerCache.length ? speakerCache : new Float32Array(0),
      [1, speakerCacheLength, SORTFORMER_HIDDEN],
    ),
    spkcache_lengths: new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(speakerCacheLength)]),
      [1],
    ),
    fifo: new ort.Tensor("float32", fifo.length ? fifo : new Float32Array(0), [
      1,
      fifoLength,
      SORTFORMER_HIDDEN,
    ]),
    fifo_lengths: new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(fifoLength)]),
      [1],
    ),
  };

  const outputs = await sortformerSession.run(inputs);
  const predictions = /** @type {Float32Array | undefined} */ (
    outputs.spkcache_fifo_chunk_preds?.data
  );
  const embeddings = /** @type {Float32Array | undefined} */ (
    outputs.chunk_pre_encode_embs?.data
  );
  if (!predictions || !embeddings) {
    throw new Error(
      "Sortformer did not return speaker predictions and embeddings",
    );
  }

  const downsampledFrames = Math.ceil(actualFrameCount / 8);
  const result = processor.processChunk(
    predictions,
    embeddings,
    downsampledFrames,
  );

  Object.values(inputs).forEach((tensor) => tensor.dispose?.());
  Object.values(outputs).forEach((tensor) => tensor.dispose?.());
  return result;
}

function describeError(err) {
  if (err instanceof Error) {
    const base = err.message || err.name || "Error";
    return err.stack ? `${base}\n${err.stack}` : base;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * @template T
 * @param {string} stage
 * @param {() => Promise<T> | T} task
 * @returns {Promise<T>}
 */
async function runStage(stage, task) {
  try {
    return await task();
  } catch (err) {
    if (typeof console !== "undefined") {
      console.error(`[diarization-worker][stage:${stage}] failed`, err);
    }
    const error = err instanceof Error ? err : new Error(describeError(err));
    error.message = `[${stage}] ${error.message}`;
    throw error;
  }
}
