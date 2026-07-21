import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelManager } from "./useModelManager.js";
import {
  getOrDownloadModelAsset,
  listCachedModelKeys,
} from "@/features/transcription/lib/modelCache.js";

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
  hasCachedModel: vi.fn().mockResolvedValue(false),
  listCachedModelKeys: vi.fn().mockResolvedValue([]),
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

  it("prefetches required models sequentially without returning their buffers", async () => {
    const store = makeStore();
    const manager = useModelManager(store);

    const prefetch = manager.ensureModelsReady("webgpu", true);
    await Promise.resolve();

    expect(downloadState.started).toEqual(["encoderFp16"]);
    downloadState.resolvers.get("encoderFp16")?.(new ArrayBuffer(1));
    await vi.waitFor(() =>
      expect(downloadState.started).toEqual(["encoderFp16", "decoder"]),
    );
    downloadState.resolvers.get("decoder")?.(new ArrayBuffer(2));
    await vi.waitFor(() =>
      expect(downloadState.started).toEqual([
        "encoderFp16",
        "decoder",
        "vocab",
      ]),
    );
    downloadState.resolvers.get("vocab")?.(new ArrayBuffer(3));
    await vi.waitFor(() =>
      expect(downloadState.started).toEqual([
        "encoderFp16",
        "decoder",
        "vocab",
        "diarization",
      ]),
    );
    downloadState.resolvers.get("diarization")?.(new ArrayBuffer(4));

    await expect(prefetch).resolves.toBeUndefined();
    expect(getOrDownloadModelAsset).toHaveBeenCalledTimes(4);
    expect(store.parakeetCached).toBe(false);
    expect(store.sortformerCached).toBe(false);
  });

  it("checks cache readiness from keys without reading model payloads", async () => {
    vi.mocked(listCachedModelKeys).mockResolvedValue([
      "parakeet-encoder-fp16",
      "parakeet-decoder",
      "parakeet-vocab",
      "sortformer-diarization",
    ]);
    const store = makeStore();

    await useModelManager(store).checkCache();

    expect(store.parakeetCached).toBe(true);
    expect(store.sortformerCached).toBe(true);
    expect(listCachedModelKeys).toHaveBeenCalledOnce();
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
    downloadState.resolvers.get("encoderFp16")?.(new ArrayBuffer(1));
    await vi.waitFor(() => expect(downloadState.started).toContain("decoder"));
    downloadState.progressCallbacks.get("decoder")?.({
      assetKey: "decoder",
      percent: 50,
      receivedBytes: 1,
      totalBytes: 2,
      source: "download",
    });
    downloadState.resolvers.get("decoder")?.(new ArrayBuffer(1));
    await vi.waitFor(() => expect(downloadState.started).toContain("vocab"));
    downloadState.progressCallbacks.get("vocab")?.({
      assetKey: "vocab",
      percent: 0,
      receivedBytes: 0,
      totalBytes: 1,
      source: "download",
    });
    downloadState.resolvers.get("vocab")?.(new ArrayBuffer(1));
    await vi.waitFor(() =>
      expect(downloadState.started).toContain("diarization"),
    );
    downloadState.progressCallbacks.get("diarization")?.({
      assetKey: "diarization",
      percent: 25,
      receivedBytes: 1,
      totalBytes: 4,
      source: "download",
    });

    expect(store.parakeetLoadProgress).toBe(50);
    expect(store.sortformerLoadProgress).toBe(25);

    downloadState.resolvers.get("diarization")?.(new ArrayBuffer(1));
    await prefetch;
  });
});
