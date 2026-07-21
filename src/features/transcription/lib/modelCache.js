import { MODEL_ASSETS } from "./modelUrls.js";
import { TRANSCRIPTION_DB_NAME } from "./transcriptionDb.js";

const DB_NAME = TRANSCRIPTION_DB_NAME;
const MODEL_STORE = "modelCache";

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
 * @param {string} cacheKey
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function getCachedModel(cacheKey) {
  const db = await openTranscriptionModelDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(MODEL_STORE, "readonly")
        .objectStore(MODEL_STORE)
        .get(cacheKey);
      request.onsuccess = () => resolve(request.result?.data ?? null);
      request.onerror = () => reject(request.error);
    });
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
          (request.result || []).filter((key) => typeof key === "string"),
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * @param {string} cacheKey
 * @param {ArrayBuffer} data
 * @param {number} sizeBytes
 */
export async function putCachedModel(cacheKey, data, sizeBytes) {
  const db = await openTranscriptionModelDb();
  try {
    await new Promise((resolve, reject) => {
      const request = db
        .transaction(MODEL_STORE, "readwrite")
        .objectStore(MODEL_STORE)
        .put({
          cacheKey,
          data,
          downloadedAt: new Date().toISOString(),
          sizeBytes,
        });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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
