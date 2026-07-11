import {
  MODEL_ASSETS,
  getRequiredAssetKeys,
} from "@/features/transcription/lib/modelUrls.js";
import {
  clearCachedModels,
  getCachedModel,
  getOrDownloadModelAsset,
  openTranscriptionModelDb,
} from "@/features/transcription/lib/modelCache.js";

/**
 * Manages model cache status and optional pre-downloads.
 * ASR transcription itself loads model buffers inside the ASR worker so the
 * main thread does not own large ONNX ArrayBuffers during processing.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useModelManager(store) {
  /** @type {AbortController | null} */
  let abortController = null;

  async function checkCache() {
    try {
      const cached = await listCachedEntries();
      const keys = new Set(cached.map((entry) => entry.cacheKey));

      const parakeetKeys = [
        "parakeet-encoder-fp16",
        "parakeet-encoder-int8",
        "parakeet-decoder",
        "parakeet-vocab",
      ];
      store.parakeetCached =
        parakeetKeys.some((key) => keys.has(key)) &&
        keys.has("parakeet-decoder") &&
        keys.has("parakeet-vocab");
      store.sortformerCached = keys.has("sortformer-diarization");
    } catch (err) {
      console.warn("Failed to check model cache:", err);
    }
  }

  /**
   * @returns {Promise<Array<{ cacheKey: string, data: ArrayBuffer, downloadedAt: string, sizeBytes: number }>>}
   */
  async function listCachedEntries() {
    const db = await openTranscriptionModelDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction("modelCache", "readonly")
          .objectStore("modelCache")
          .getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  /**
   * Download a single model asset with progress reporting.
   * @param {string} assetKey
   * @param {AbortSignal} signal
   * @returns {Promise<ArrayBuffer>}
   */
  async function downloadAsset(
    assetKey,
    signal,
    onAssetProgress = reportAssetProgress,
  ) {
    return await getOrDownloadModelAsset(assetKey, signal, ({ percent }) => {
      if (percent != null) onAssetProgress(assetKey, percent);
      else store.parakeetLoadIndeterminate = true;
    });
  }

  /**
   * @param {string} assetKey
   * @param {number} percent
   */
  function reportAssetProgress(assetKey, percent) {
    const asset = MODEL_ASSETS[assetKey];
    if (!asset) return;
    if (asset.runtime === "diarization") {
      store.sortformerLoadProgress = percent;
    } else {
      store.parakeetLoadIndeterminate = false;
      store.parakeetLoadProgress = percent;
    }
  }

  /**
   * Build a reporter that combines progress across every ASR asset in the
   * current prefetch set while keeping diarization progress separate.
   *
   * @param {string[]} requiredKeys
   */
  function createPrefetchProgressReporter(requiredKeys) {
    const progressByKey = new Map(requiredKeys.map((key) => [key, 0]));
    const parakeetKeys = requiredKeys.filter(
      (key) => MODEL_ASSETS[key]?.runtime !== "diarization",
    );

    return (assetKey, percent) => {
      const asset = MODEL_ASSETS[assetKey];
      if (!asset) return;

      progressByKey.set(assetKey, Math.min(100, Math.max(0, percent)));
      if (asset.runtime === "diarization") {
        store.sortformerLoadProgress = progressByKey.get(assetKey) || 0;
        return;
      }

      store.parakeetLoadIndeterminate = false;
      if (!parakeetKeys.length) {
        store.parakeetLoadProgress = 0;
        return;
      }
      const total = parakeetKeys.reduce(
        (sum, key) => sum + (progressByKey.get(key) || 0),
        0,
      );
      store.parakeetLoadProgress = total / parakeetKeys.length;
    };
  }

  /**
   * Optional pre-download helper for settings/cache UI. Transcription does not
   * call this for ASR because workers own model loading during processing.
   * @param {'webgpu' | 'wasm'} runtime
   * @param {boolean} diarization
   * @returns {Promise<Record<string, ArrayBuffer>>}
   */
  async function ensureModelsReady(runtime, diarization) {
    abortController = new AbortController();
    const signal = abortController.signal;
    const requiredKeys = getRequiredAssetKeys(runtime, diarization);
    const reportPrefetchProgress = createPrefetchProgressReporter(requiredKeys);

    /** @type {Record<string, ArrayBuffer>} */
    const buffers = {};
    await Promise.all(
      requiredKeys.map(async (key) => {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        buffers[key] = await downloadAsset(key, signal, reportPrefetchProgress);
      }),
    );

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    await checkCache();
    return buffers;
  }

  /**
   * @param {string} assetKey
   * @returns {Promise<ArrayBuffer | null>}
   */
  async function getModelBuffer(assetKey) {
    const asset = MODEL_ASSETS[assetKey];
    if (!asset) return null;
    return await getCachedModel(asset.cacheKey);
  }

  async function clearModelCache() {
    await clearCachedModels();
    store.parakeetCached = false;
    store.sortformerCached = false;
    store.parakeetLoadProgress = 0;
    store.parakeetLoadIndeterminate = false;
    store.sortformerLoadProgress = 0;
  }

  /**
   * Pre-download the diarization (Sortformer) model so it is cached before
   * the diarization worker needs it. Sets `processPhase` to reflect whether
   * the model is being downloaded or loaded from cache.
   */
  async function ensureDiarizationModel() {
    abortController = abortController || new AbortController();
    const signal = abortController.signal;
    await getOrDownloadModelAsset("diarization", signal, (progress) => {
      if (progress.source === "cache") {
        store.processPhase = "loading-diarization-model";
      } else {
        store.processPhase = "downloading-diarization-model";
      }
      if (progress.percent != null) {
        store.sortformerLoadProgress = progress.percent;
      }
    });
    store.sortformerCached = true;
  }

  function abort() {
    abortController?.abort();
    abortController = null;
  }

  return {
    checkCache,
    ensureModelsReady,
    ensureDiarizationModel,
    getModelBuffer,
    clearModelCache,
    abort,
  };
}
