import { MODEL_ASSETS } from "@/features/transcription/lib/modelUrls.js";
import {
  clearCachedModels,
  getCachedModel,
  getOrDownloadModelAsset,
  hasCachedModel,
  listCachedModelKeys,
} from "@/features/transcription/lib/modelCache.js";

const DEFAULT_ASSET_KEYS = [
  "encoderFp16",
  "decoder",
  "vocab",
  "nemotronInt8",
  "nemotronInt8Data",
];

/** @param {string} key */
function isDiarizationAsset(key) {
  return MODEL_ASSETS[key]?.runtime === "diarization";
}

/**
 * Manages model cache status and optional pre-downloads.
 * Store fields keep their historical names: `parakeet*` tracks the selected
 * ASR engine's assets and `sortformer*` the selected diarizer's.
 * ASR transcription itself loads model buffers inside the ASR worker so the
 * main thread does not own large ONNX ArrayBuffers during processing.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useModelManager(store) {
  /** @type {AbortController | null} */
  let abortController = null;

  /**
   * @param {string[]} [assetKeys] the selected engines' assets
   */
  async function checkCache(assetKeys = DEFAULT_ASSET_KEYS) {
    try {
      const cached = new Set(await listCachedModelKeys());
      const isCached = (/** @type {string} */ key) =>
        cached.has(MODEL_ASSETS[key]?.cacheKey);
      const asrKeys = assetKeys.filter((key) => !isDiarizationAsset(key));
      const diarizationKeys = assetKeys.filter(isDiarizationAsset);
      store.parakeetCached = asrKeys.length > 0 && asrKeys.every(isCached);
      store.sortformerCached =
        diarizationKeys.length > 0 && diarizationKeys.every(isCached);
    } catch (err) {
      console.warn("Failed to check model cache:", err);
    }
  }

  /**
   * Download a single model asset with progress reporting.
   * @param {string} assetKey
   * @param {AbortSignal} signal
   * Streams into the cache without keeping the bytes on the main thread;
   * workers read their models back from the cache.
   */
  async function downloadAsset(
    assetKey,
    signal,
    onAssetProgress = reportAssetProgress,
  ) {
    await getOrDownloadModelAsset(
      assetKey,
      signal,
      ({ percent }) => {
        if (percent != null) onAssetProgress(assetKey, percent);
        else store.parakeetLoadIndeterminate = true;
      },
      { keepBytes: false },
    );
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
   * @param {string[]} requiredKeys the selected engines' assets
   * @returns {Promise<void>}
   */
  async function ensureModelsReady(requiredKeys) {
    abortController = new AbortController();
    const signal = abortController.signal;
    const reportPrefetchProgress = createPrefetchProgressReporter(requiredKeys);

    for (const key of requiredKeys) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await downloadAsset(key, signal, reportPrefetchProgress);
    }

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    await checkCache(requiredKeys);
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
   * Pre-download the selected diarizer's assets so they are cached before the
   * diarization worker needs them. Sets `processPhase` to reflect whether the
   * model is being downloaded or loaded from cache.
   * @param {string[]} [assetKeys] the selected engines' assets
   */
  async function ensureDiarizationModel(assetKeys = DEFAULT_ASSET_KEYS) {
    abortController = abortController || new AbortController();
    const signal = abortController.signal;
    const keys = assetKeys.filter(isDiarizationAsset);
    const progressByKey = new Map(keys.map((key) => [key, 0]));
    for (const key of keys) {
      if (await hasCachedModel(MODEL_ASSETS[key].cacheKey)) {
        store.processPhase = "loading-diarization-model";
        progressByKey.set(key, 100);
        continue;
      }
      await getOrDownloadModelAsset(
        key,
        signal,
        (progress) => {
          store.processPhase =
            progress.source === "cache"
              ? "loading-diarization-model"
              : "downloading-diarization-model";
          if (progress.percent != null) {
            progressByKey.set(key, progress.percent);
            store.sortformerLoadProgress =
              [...progressByKey.values()].reduce(
                (sum, value) => sum + value,
                0,
              ) / progressByKey.size;
          }
        },
        { keepBytes: false },
      );
    }
    store.sortformerLoadProgress = 100;
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
