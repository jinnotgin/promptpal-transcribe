import { MODEL_ASSETS } from "./modelUrls.js";
import { TRANSCRIPTION_DB_NAME } from "./transcriptionDb.js";

const DB_NAME = TRANSCRIPTION_DB_NAME;
const MODEL_STORE = "modelCache";
/**
 * Models are cached in 64 MB records: some Chromium builds reject IndexedDB
 * values above ~128 MB instead of spilling them to blob storage.
 */
const MODEL_CHUNK_BYTES = 64 * 1024 * 1024;
const CHUNK_KEY_SEPARATOR = "::chunk::";

/** @param {string} cacheKey @param {number} index */
function chunkKey(cacheKey, index) {
  return `${cacheKey}${CHUNK_KEY_SEPARATOR}${index}`;
}

/**
 * @returns {Promise<IDBDatabase>}
 */
export function openTranscriptionModelDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result;
      ensureStores(db);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(MODEL_STORE)) {
        resolve(db);
        return;
      }

      const nextVersion = db.version + 1;
      db.close();
      const upgradeRequest = indexedDB.open(DB_NAME, nextVersion);
      upgradeRequest.onupgradeneeded = () => {
        ensureStores(upgradeRequest.result);
      };
      upgradeRequest.onsuccess = () => resolve(upgradeRequest.result);
      upgradeRequest.onerror = () => reject(upgradeRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {IDBDatabase} db
 */
function ensureStores(db) {
  if (!db.objectStoreNames.contains("transcripts")) {
    db.createObjectStore("transcripts", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(MODEL_STORE)) {
    db.createObjectStore(MODEL_STORE, { keyPath: "cacheKey" });
  }
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 * @returns {Promise<any>}
 */
function readRecord(db, key) {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(MODEL_STORE, "readonly")
      .objectStore(MODEL_STORE)
      .get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {Record<string, unknown>} record
 */
function writeRecord(db, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MODEL_STORE, "readwrite");
    transaction.objectStore(MODEL_STORE).put(record);
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error || new Error("Model cache write aborted"));
  });
}

/**
 * @param {string} cacheKey
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function getCachedModel(cacheKey) {
  const db = await openTranscriptionModelDb();
  try {
    const record = await readRecord(db, cacheKey);
    if (!record) return null;
    if (!Number.isInteger(record.chunks)) return record.data ?? null;

    const bytes = new Uint8Array(record.sizeBytes);
    let offset = 0;
    for (let index = 0; index < record.chunks; index += 1) {
      const chunk = await readRecord(db, chunkKey(cacheKey, index));
      if (!chunk?.data) return null;
      bytes.set(new Uint8Array(chunk.data), offset);
      offset += chunk.data.byteLength;
    }
    return offset === record.sizeBytes ? bytes.buffer : null;
  } finally {
    db.close();
  }
}

/**
 * @param {string} cacheKey
 * @returns {Promise<boolean>}
 */
export async function hasCachedModel(cacheKey) {
  const db = await openTranscriptionModelDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(MODEL_STORE, "readonly")
        .objectStore(MODEL_STORE)
        .getKey(cacheKey);
      request.onsuccess = () => resolve(request.result !== undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Read cache keys without cloning the model ArrayBuffer payloads.
 * @returns {Promise<string[]>}
 */
export async function listCachedModelKeys() {
  const db = await openTranscriptionModelDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(MODEL_STORE, "readonly")
        .objectStore(MODEL_STORE)
        .getAllKeys();
      request.onsuccess = () =>
        resolve(
          (request.result || []).filter(
            /** @returns {key is string} */
            (key) =>
              typeof key === "string" && !key.includes(CHUNK_KEY_SEPARATOR),
          ),
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Store a model. Large models are written as chunk records first and the
 * manifest record last, so a key is only listed once every chunk exists.
 * @param {string} cacheKey
 * @param {ArrayBuffer} data
 * @param {number} sizeBytes
 * @param {{ chunkBytes?: number }} [options]
 */
export async function putCachedModel(cacheKey, data, sizeBytes, options = {}) {
  const chunkBytes = options.chunkBytes ?? MODEL_CHUNK_BYTES;
  const downloadedAt = new Date().toISOString();
  const db = await openTranscriptionModelDb();
  try {
    if (data.byteLength <= chunkBytes) {
      await writeRecord(db, { cacheKey, data, downloadedAt, sizeBytes });
      return;
    }
    const chunks = Math.ceil(data.byteLength / chunkBytes);
    for (let index = 0; index < chunks; index += 1) {
      await writeRecord(db, {
        cacheKey: chunkKey(cacheKey, index),
        data: data.slice(index * chunkBytes, (index + 1) * chunkBytes),
      });
    }
    await writeRecord(db, {
      cacheKey,
      chunks,
      downloadedAt,
      sizeBytes: data.byteLength,
    });
  } finally {
    db.close();
  }
}

export async function clearCachedModels() {
  const db = await openTranscriptionModelDb();
  try {
    await new Promise((resolve, reject) => {
      const request = db
        .transaction(MODEL_STORE, "readwrite")
        .objectStore(MODEL_STORE)
        .clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Return a cached model or download it. Downloads are written to the cache
 * in `chunkBytes` records as they arrive, so a 1 GB model never needs a
 * second full copy; with `keepBytes: false` (prefetch) only one chunk is
 * held at a time and nothing is returned.
 * @param {string} assetKey
 * @param {AbortSignal} signal
 * @param {(progress: { assetKey: string, percent: number | null, receivedBytes: number, totalBytes: number | null, source: 'cache' | 'download' }) => void} [onProgress]
 * @param {{ keepBytes?: boolean, chunkBytes?: number }} [options]
 * @returns {Promise<ArrayBuffer | null>} null only when `keepBytes` is false
 */
export async function getOrDownloadModelAsset(
  assetKey,
  signal,
  onProgress,
  options = {},
) {
  const asset = MODEL_ASSETS[assetKey];
  if (!asset) throw new Error(`Unknown model asset: ${assetKey}`);
  const keepBytes = options.keepBytes ?? true;
  const chunkBytes = options.chunkBytes ?? MODEL_CHUNK_BYTES;

  if (!keepBytes && (await hasCachedModel(asset.cacheKey))) {
    onProgress?.({
      assetKey,
      percent: 100,
      receivedBytes: 0,
      totalBytes: null,
      source: "cache",
    });
    return null;
  }
  const cached = keepBytes ? await getCachedModel(asset.cacheKey) : null;
  if (cached) {
    onProgress?.({
      assetKey,
      percent: 100,
      receivedBytes: cached.byteLength,
      totalBytes: cached.byteLength,
      source: "cache",
    });
    return cached;
  }

  const response = await fetch(asset.url, { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to download ${assetKey}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error(
      `Failed to download ${assetKey}: response body is unavailable`,
    );
  }

  const totalBytes =
    Number(response.headers.get("content-length") || 0) || null;
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const kept = [];
  let chunk = new Uint8Array(chunkBytes);
  let chunkFill = 0;
  let chunkCount = 0;
  let receivedBytes = 0;
  const db = await openTranscriptionModelDb();
  try {
    const flushChunk = async () => {
      const data = chunk.slice(0, chunkFill).buffer;
      await writeRecord(db, {
        cacheKey: chunkKey(asset.cacheKey, chunkCount),
        data,
      });
      if (keepBytes) kept.push(new Uint8Array(data));
      chunkCount += 1;
      chunkFill = 0;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(
          value.byteLength - offset,
          chunkBytes - chunkFill,
        );
        chunk.set(value.subarray(offset, offset + take), chunkFill);
        chunkFill += take;
        offset += take;
        if (chunkFill === chunkBytes) await flushChunk();
      }
      receivedBytes += value.byteLength;
      onProgress?.({
        assetKey,
        percent: totalBytes
          ? Math.min(100, (receivedBytes / totalBytes) * 100)
          : null,
        receivedBytes,
        totalBytes,
        source: "download",
      });
    }

    const downloadedAt = new Date().toISOString();
    /** @type {ArrayBuffer | null} */
    let bytes = null;
    if (chunkCount === 0) {
      // Small model: one record, as putCachedModel writes it.
      const data = chunk.slice(0, chunkFill).buffer;
      await writeRecord(db, {
        cacheKey: asset.cacheKey,
        data,
        downloadedAt,
        sizeBytes: receivedBytes,
      });
      bytes = data;
    } else {
      if (chunkFill > 0) await flushChunk();
      await writeRecord(db, {
        cacheKey: asset.cacheKey,
        chunks: chunkCount,
        downloadedAt,
        sizeBytes: receivedBytes,
      });
      if (keepBytes) {
        const joined = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const part of kept.splice(0)) {
          joined.set(part, offset);
          offset += part.byteLength;
        }
        bytes = joined.buffer;
      }
    }
    chunk = new Uint8Array(0);
    onProgress?.({
      assetKey,
      percent: 100,
      receivedBytes,
      totalBytes: totalBytes ?? receivedBytes,
      source: "download",
    });
    return keepBytes ? bytes : null;
  } finally {
    db.close();
  }
}
