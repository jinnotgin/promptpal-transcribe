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

function rawModelKeys() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(TRANSCRIPTION_DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db
        .transaction("modelCache")
        .objectStore("modelCache")
        .getAllKeys();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    };
  });
}

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

  it("streams large downloads into chunk records without keeping the bytes", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 3));
              controller.enqueue(bytes.subarray(3, 9));
              controller.enqueue(bytes.subarray(9));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-length": "10" } },
        ),
      ),
    );

    const result = await getOrDownloadModelAsset(
      "vocab",
      new AbortController().signal,
      undefined,
      { keepBytes: false, chunkBytes: 4 },
    );

    expect(result).toBeNull();
    expect(await rawModelKeys()).toHaveLength(4);
    expect(
      Array.from(new Uint8Array(await getCachedModel("parakeet-vocab"))),
    ).toEqual(Array.from(bytes));
  });

  it("returns streamed bytes when they are kept", async () => {
    const bytes = Uint8Array.from({ length: 9 }, (_, index) => index * 3);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })),
    );

    const result = await getOrDownloadModelAsset(
      "vocab",
      new AbortController().signal,
      undefined,
      { chunkBytes: 4 },
    );

    expect(Array.from(new Uint8Array(result))).toEqual(Array.from(bytes));
    expect(
      Array.from(new Uint8Array(await getCachedModel("parakeet-vocab"))),
    ).toEqual(Array.from(bytes));
  });

  it("skips reading a cached model when the bytes are not needed", async () => {
    await putCachedModel("parakeet-vocab", Uint8Array.of(1, 2).buffer, 2);
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(() => {
      throw new Error("payload reads are forbidden");
    });
    const progress = vi.fn();

    await expect(
      getOrDownloadModelAsset("vocab", new AbortController().signal, progress, {
        keepBytes: false,
      }),
    ).resolves.toBeNull();
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 100, source: "cache" }),
    );
  });

  it("stores large models as chunks and reassembles them", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index + 1);
    await putCachedModel("big-model", bytes.buffer, bytes.length, {
      chunkBytes: 4,
    });

    expect(
      Array.from(new Uint8Array(await getCachedModel("big-model"))),
    ).toEqual(Array.from(bytes));
    await expect(hasCachedModel("big-model")).resolves.toBe(true);
    await expect(listCachedModelKeys()).resolves.toEqual(["big-model"]);
    expect(await rawModelKeys()).toHaveLength(4);
  });

  it("still reads models cached as a single record", async () => {
    await putCachedModel("small-model", Uint8Array.of(9, 8).buffer, 2);
    expect(
      Array.from(new Uint8Array(await getCachedModel("small-model"))),
    ).toEqual([9, 8]);
  });

  it("rejects instead of hanging when the write transaction aborts", async () => {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function () {
      const transaction = this.transaction;
      queueMicrotask(() => transaction.abort());
      return /** @type {any} */ ({});
    });
    await expect(
      putCachedModel("doomed", new ArrayBuffer(8), 8),
    ).rejects.toThrow();
  });
});
