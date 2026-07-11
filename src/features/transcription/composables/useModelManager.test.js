import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelManager } from "./useModelManager.js";
import { getOrDownloadModelAsset } from "@/features/transcription/lib/modelCache.js";

const downloadState = vi.hoisted(() => ({
  started: /** @type {string[]} */ ([]),
  resolvers: /** @type {Map<string, (value: ArrayBuffer) => void>} */ (
    new Map()
  ),
  progressCallbacks:
    /** @type {Map<string, (progress: { assetKey: string, percent: number, receivedBytes: number, totalBytes: number, source: 'download' }) => void>} */ (
      new Map()
    ),
}));

vi.mock("@/features/transcription/lib/modelCache.js", () => ({
  clearCachedModels: vi.fn().mockResolvedValue(undefined),
  getCachedModel: vi.fn().mockResolvedValue(null),
  getOrDownloadModelAsset: vi.fn((assetKey, _signal, onProgress) => {
    downloadState.started.push(assetKey);
    if (onProgress) downloadState.progressCallbacks.set(assetKey, onProgress);
    onProgress?.({
      assetKey,
      percent: 0,
      receivedBytes: 0,
      totalBytes: 1,
      source: "download",
    });
    return new Promise((resolve) => {
      downloadState.resolvers.set(assetKey, resolve);
    });
  }),
  openTranscriptionModelDb: vi.fn().mockResolvedValue({
    transaction: () => ({
      objectStore: () => ({
        getAll: () => {
          const request = {
            result: [],
            error: null,
            onsuccess: null,
            onerror: null,
          };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
      }),
    }),
    close: vi.fn(),
  }),
}));

function makeStore() {
  return /** @type {any} */ ({
    parakeetCached: false,
    sortformerCached: false,
    parakeetLoadProgress: 0,
    parakeetLoadIndeterminate: false,
    sortformerLoadProgress: 0,
  });
}

describe("useModelManager", () => {
  beforeEach(() => {
    downloadState.started = [];
    downloadState.resolvers.clear();
    downloadState.progressCallbacks.clear();
    vi.clearAllMocks();
  });

  it("starts all required model prefetch downloads in parallel", async () => {
    const store = makeStore();
    const manager = useModelManager(store);

    const prefetch = manager.ensureModelsReady("webgpu", true);
    await Promise.resolve();

    expect(downloadState.started).toEqual([
      "encoderFp16",
      "decoder",
      "vocab",
      "diarization",
    ]);
    expect(getOrDownloadModelAsset).toHaveBeenCalledTimes(4);

    downloadState.resolvers.get("encoderFp16")?.(new ArrayBuffer(1));
    downloadState.resolvers.get("decoder")?.(new ArrayBuffer(2));
    downloadState.resolvers.get("vocab")?.(new ArrayBuffer(3));
    downloadState.resolvers.get("diarization")?.(new ArrayBuffer(4));

    await expect(prefetch).resolves.toEqual({
      encoderFp16: expect.any(ArrayBuffer),
      decoder: expect.any(ArrayBuffer),
      vocab: expect.any(ArrayBuffer),
      diarization: expect.any(ArrayBuffer),
    });
    expect(store.parakeetCached).toBe(false);
    expect(store.sortformerCached).toBe(false);
  });

  it("reports aggregate ASR progress while keeping diarization progress separate", async () => {
    const store = makeStore();
    const manager = useModelManager(store);

    const prefetch = manager.ensureModelsReady("webgpu", true);
    await Promise.resolve();

    downloadState.progressCallbacks.get("encoderFp16")?.({
      assetKey: "encoderFp16",
      percent: 100,
      receivedBytes: 1,
      totalBytes: 1,
      source: "download",
    });
    downloadState.progressCallbacks.get("decoder")?.({
      assetKey: "decoder",
      percent: 50,
      receivedBytes: 1,
      totalBytes: 2,
      source: "download",
    });
    downloadState.progressCallbacks.get("vocab")?.({
      assetKey: "vocab",
      percent: 0,
      receivedBytes: 0,
      totalBytes: 1,
      source: "download",
    });
    downloadState.progressCallbacks.get("diarization")?.({
      assetKey: "diarization",
      percent: 25,
      receivedBytes: 1,
      totalBytes: 4,
      source: "download",
    });

    expect(store.parakeetLoadProgress).toBe(50);
    expect(store.sortformerLoadProgress).toBe(25);

    for (const key of downloadState.started) {
      downloadState.resolvers.get(key)?.(new ArrayBuffer(1));
    }
    await prefetch;
  });
});
