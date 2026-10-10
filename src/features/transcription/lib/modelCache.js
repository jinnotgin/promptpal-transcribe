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
 * @param {string} assetKey
 * @param {AbortSignal} signal
 * @param {(progress: { assetKey: string, percent: number | null, receivedBytes: number, totalBytes: number | null, source: 'cache' | 'download' }) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function getOrDownloadModelAsset(assetKey, signal, onProgress) {
  const asset = MODEL_ASSETS[assetKey];
  if (!asset) throw new Error(`Unknown model asset: ${assetKey}`);

  const cached = await getCachedModel(asset.cacheKey);
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
  let preallocated = totalBytes ? new Uint8Array(totalBytes) : null;
  const chunks = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (
      preallocated &&
      receivedBytes + value.byteLength <= preallocated.byteLength
    ) {
      preallocated.set(value, receivedBytes);
    } else {
      if (preallocated) {
        chunks.push(preallocated.subarray(0, receivedBytes));
        preallocated = null;
      }
      chunks.push(value);
    }
    receivedBytes += value.byteLength;
    onProgress?.({
      assetKey,
      percent: totalBytes ? (receivedBytes / totalBytes) * 100 : null,
      receivedBytes,
      totalBytes,
      source: "download",
    });
  }

  let bytes = preallocated
    ? preallocated.byteLength === receivedBytes
      ? preallocated
      : preallocated.slice(0, receivedBytes)
    : null;
  if (!bytes) {
    bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  await putCachedModel(asset.cacheKey, bytes.buffer, receivedBytes);
  onProgress?.({
    assetKey,
    percent: 100,
    receivedBytes,
    totalBytes: totalBytes ?? receivedBytes,
    source: "download",
  });
  return bytes.buffer;
}
