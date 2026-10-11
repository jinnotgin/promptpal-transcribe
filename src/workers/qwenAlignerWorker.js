/**
 * Qwen3-ForcedAligner worker (WebGPU): replaces Qwen3-ASR's proportional
 * timings with real per-character / per-word timings.
 *
 * Requests: `init`, then `align` per transcribed region with its PCM, text,
 * start time and speaker; replies with the region's timed segments.
 */

// The WebGPU build, as for the Qwen3-ASR worker (onnxruntime-web 1.30).
import * as ort from "onnxruntime-web/webgpu";
import { getOrDownloadModelAsset } from "@/features/transcription/lib/modelCache.js";
import { configureOrtWasm } from "@/features/transcription/lib/ortRuntime.js";
import { createQwenAligner } from "@/features/transcription/lib/qwenAligner.js";
import { parseMerges } from "@/features/transcription/lib/qwenAlignerText.js";
import { buildAlignedSegments } from "@/features/transcription/lib/qwenAsrSegments.js";

/** @type {import('onnxruntime-web').InferenceSession | null} */
let session = null;
/** @type {ReturnType<typeof createQwenAligner> | null} */
let aligner = null;
/** @type {AbortController | null} */
let abortController = null;
let cancelled = false;

self.onmessage = async (event) => {
  const { type, payload, requestId } = event.data;
  try {
    switch (type) {
      case "init":
        await initialize();
        reply("ready", requestId, {});
        break;
      case "align":
        reply("aligned", requestId, await align(payload));
        break;
      case "cancel":
        cancelled = true;
        abortController?.abort();
        await session?.release().catch(() => {});
        session = null;
        aligner = null;
        break;
    }
  } catch (error) {
    if (cancelled) return;
    console.error(`[aligner-worker][${type}]`, error);
    self.postMessage({
      type: "error",
      requestId,
      payload: {
        code: "ALIGNMENT_FAILED",
        message: `Word alignment ${type} failed: ${error?.message || String(error)}`,
      },
    });
  }
};

async function initialize() {
  cancelled = false;
  abortController = new AbortController();
  if (aligner) return;
  const onProgress = (progress) =>
    self.postMessage({ type: "model-progress", payload: progress });
  const [model, merges, vocab] = await Promise.all(
    ["alignerQ4", "alignerMerges", "qwenVocab"].map((key) =>
      getOrDownloadModelAsset(key, abortController.signal, onProgress),
    ),
  );
  configureOrtWasm(ort);
  session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ["webgpu"],
    graphOptimizationLevel: "all",
  });
  const text = new TextDecoder();
  aligner = createQwenAligner({
    runModel,
    vocab: JSON.parse(text.decode(vocab)),
    merges: parseMerges(text.decode(merges)),
  });
}

/** @type {import('@/features/transcription/lib/qwenAligner.js').RunAligner} */
async function runModel({ inputIds, features, frames }) {
  if (!session) throw new Error("Aligner session is not initialized");
  const length = inputIds.length;
  const feeds = {
    input_ids: new ort.Tensor("int64", inputIds, [1, length]),
    input_features: new ort.Tensor("float32", features, [1, 128, frames]),
    attention_mask: new ort.Tensor(
      "int64",
      new BigInt64Array(length).fill(1n),
      [1, length],
    ),
    feature_attention_mask: new ort.Tensor(
      "int32",
      new Int32Array(frames).fill(1),
      [1, frames],
    ),
  };
  const outputs = await session.run(feeds);
  try {
    return {
      logits: Float32Array.from(
        /** @type {Float32Array} */ (outputs.logits.data),
      ),
      classes: Number(outputs.logits.dims[2]),
    };
  } finally {
    Object.values(feeds).forEach((tensor) => tensor.dispose?.());
    Object.values(outputs).forEach((tensor) => tensor.dispose?.());
  }
}

/**
 * @param {{ pcmBuffer: ArrayBuffer, text: string, start: number, speaker: string | null }} payload
 */
async function align({ pcmBuffer, text, start, speaker }) {
  if (!aligner) throw new Error("Aligner is not initialized");
  const startedAt = performance.now();
  const pcm = new Float32Array(pcmBuffer);
  const times = await aligner.align(pcm, text, { offset: start });
  return {
    segments: times ? buildAlignedSegments(text, times, { speaker }) : null,
    diagnostics: {
      engine: "qwen3-forced-aligner",
      units: times?.length ?? 0,
      rtf:
        (performance.now() - startedAt) /
        1000 /
        Math.max(0.01, pcm.length / 16000),
    },
  };
}

/**
 * @param {string} type
 * @param {number | undefined} requestId
 * @param {unknown} payload
 */
function reply(type, requestId, payload) {
  if (!cancelled) self.postMessage({ type, requestId, payload });
}
