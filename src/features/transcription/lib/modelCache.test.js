import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrDownloadModelAsset,
  getCachedModel,
  hasCachedModel,
  listCachedModelKeys,
  putCachedModel,
} from "@/features/transcription/lib/modelCache.js";
import { TRANSCRIPTION_DB_NAME } from "@/features/transcription/lib/transcriptionDb.js";

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(TRANSCRIPTION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("transcription model cache metadata", () => {
  beforeEach(deleteDatabase);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await deleteDatabase();
  });

  it("checks keys without reading or listing model payload rows", async () => {
    await putCachedModel("model-a", new ArrayBuffer(1024), 1024);
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(() => {
      throw new Error("payload reads are forbidden");
    });
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => {
      throw new Error("payload listing is forbidden");
    });

    await expect(hasCachedModel("model-a")).resolves.toBe(true);
    await expect(hasCachedModel("missing")).resolves.toBe(false);
    await expect(listCachedModelKeys()).resolves.toEqual(["model-a"]);
  });

  it("preserves downloaded bytes when content-length is an inaccurate upper bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "5" },
        }),
      ),
    );

    const downloaded = await getOrDownloadModelAsset(
      "vocab",
      new AbortController().signal,
    );

    expect(Array.from(new Uint8Array(downloaded))).toEqual([1, 2, 3]);
    expect(
      Array.from(new Uint8Array(await getCachedModel("parakeet-vocab"))),
    ).toEqual([1, 2, 3]);
  });
});
