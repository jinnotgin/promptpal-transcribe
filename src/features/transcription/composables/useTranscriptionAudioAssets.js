import { db } from "@/features/transcription/lib/transcriptionDb.js";

const AUDIO_STAGING_LEASE_PREFIX = "promptpal-transcription:audio-staging:";
const DEFAULT_LEASE_HEARTBEAT_MS = 30_000;
const DEFAULT_LEASE_STALE_MS = 5 * 60_000;

/**
 * Bounded, format-aware binary persistence for uploaded proxies, native
 * MediaRecorder fragments, and temporary position-aware MP3 export pages.
 * Cross-tab staging leases intentionally live outside IndexedDB so schema v3
 * remains unchanged.
 *
 * @param {{
 *   leaseStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
 *   now?: () => number,
 *   setInterval?: (callback: () => void, delay: number) => unknown,
 *   clearInterval?: (intervalId: unknown) => void,
 *   leaseHeartbeatMs?: number,
 *   leaseStaleMs?: number,
 *   ownerId?: string,
 * }} [options]
 */
export function useTranscriptionAudioAssets(options = {}) {
  let leaseStorage = Object.prototype.hasOwnProperty.call(
    options,
    "leaseStorage",
  )
    ? options.leaseStorage
    : resolveLeaseStorage();
  const now = options.now ?? Date.now;
  const scheduleInterval =
    options.setInterval ?? globalThis.setInterval?.bind(globalThis);
  const cancelInterval =
    options.clearInterval ?? globalThis.clearInterval?.bind(globalThis);
  const leaseHeartbeatMs = positiveInteger(
    options.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS,
    "lease heartbeat",
  );
  const leaseStaleMs = positiveInteger(
    options.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS,
    "lease stale threshold",
  );
  const ownerId = options.ownerId || createOwnerId();
  /** @type {Map<string, unknown>} */
  const leaseIntervals = new Map();

  /** @param {string} transcriptId */
  async function beginStaging(transcriptId) {
    if (!transcriptId) throw new Error("Transcript id is required");
    stopLeaseHeartbeat(transcriptId);
    if (!writeLease(transcriptId)) return;
    if (typeof scheduleInterval === "function") {
      const intervalId = scheduleInterval(
        () => writeLease(transcriptId),
        leaseHeartbeatMs,
      );
      leaseIntervals.set(transcriptId, intervalId);
    }
  }

  /** @param {string} transcriptId */
  async function finishStaging(transcriptId) {
    if (!transcriptId) return;
    stopLeaseHeartbeat(transcriptId);
    const lease = readLease(transcriptId);
    if (!lease || lease.ownerId === ownerId) removeLease(transcriptId);
  }

  /**
   * @param {{ transcriptId: string, partIndex: number, fragmentIndex: number, blob: Blob }} fragment
   */
  async function stageFragment(fragment) {
    if (!fragment.transcriptId) throw new Error("Transcript id is required");
    if (!(fragment.blob instanceof Blob) || fragment.blob.size <= 0) {
      throw new Error("Audio fragment must contain bytes");
    }
    const partIndex = nonNegativeInteger(fragment.partIndex, "part index");
    const fragmentIndex = nonNegativeInteger(
      fragment.fragmentIndex,
      "fragment index",
    );
    await db.transcriptAudioFragments.put({
      transcriptId: fragment.transcriptId,
      partIndex,
      fragmentIndex,
      blob: fragment.blob,
    });
    if (leaseIntervals.has(fragment.transcriptId))
      writeLease(fragment.transcriptId);
  }

  /**
   * Patch only the fixed-size pages affected by a position-aware encoder write.
   * Xing metadata can rewrite a few bytes near the beginning during finalize.
   * @param {{
   *   transcriptId: string,
   *   partIndex: number,
   *   position: number,
   *   data: Uint8Array,
   *   pageSize: number,
   *   mimeType?: string,
   * }} write
   */
  async function stagePositionedWrite(write) {
    if (!write.transcriptId) throw new Error("Transcript id is required");
    if (!(write.data instanceof Uint8Array) || write.data.byteLength <= 0) {
      throw new Error("Positioned audio write must contain bytes");
    }
    const partIndex = nonNegativeInteger(write.partIndex, "part index");
    const position = nonNegativeInteger(write.position, "write position");
    const pageSize = positiveInteger(write.pageSize, "page size");
    const mimeType = write.mimeType || "audio/mpeg";
    let sourceOffset = 0;

    while (sourceOffset < write.data.byteLength) {
      const absolutePosition = position + sourceOffset;
      const fragmentIndex = Math.floor(absolutePosition / pageSize);
      const pageOffset = absolutePosition % pageSize;
      const writeLength = Math.min(
        pageSize - pageOffset,
        write.data.byteLength - sourceOffset,
      );
      const key = [write.transcriptId, partIndex, fragmentIndex];
      const existing = await db.transcriptAudioFragments.get(key);
      const existingBytes = existing
        ? new Uint8Array(await existing.blob.arrayBuffer())
        : new Uint8Array();
      const pageLength = Math.max(
        existingBytes.byteLength,
        pageOffset + writeLength,
      );
      if (pageLength > pageSize)
        throw new Error("Positioned audio page exceeded its bound");
      const page = new Uint8Array(pageLength);
      page.set(existingBytes);
      page.set(
        write.data.subarray(sourceOffset, sourceOffset + writeLength),
        pageOffset,
      );
      await db.transcriptAudioFragments.put({
        transcriptId: write.transcriptId,
        partIndex,
        fragmentIndex,
        blob: new Blob([page], { type: mimeType }),
      });
      sourceOffset += writeLength;
    }
    if (leaseIntervals.has(write.transcriptId)) writeLease(write.transcriptId);
  }

  /** @param {string} transcriptId @param {number} partIndex */
  async function getStagedPartStats(transcriptId, partIndex) {
    const normalizedPartIndex = nonNegativeInteger(partIndex, "part index");
    const rows = await db.transcriptAudioFragments
      .where("[transcriptId+partIndex]")
      .equals([transcriptId, normalizedPartIndex])
      .sortBy("fragmentIndex");
    rows.forEach((row, index) => {
      if (row.fragmentIndex !== index) {
        throw new Error(`Audio part ${normalizedPartIndex} is out of order`);
      }
    });
    return {
      sizeBytes: rows.reduce((total, row) => total + row.blob.size, 0),
      fragmentCount: rows.length,
    };
  }

  /**
   * @param {string} transcriptId
   * @param {{ index: number, mimeType: string, fragmentCount: number }} part
   */
  async function getPartBlob(transcriptId, part) {
    const rows = await db.transcriptAudioFragments
      .where("[transcriptId+partIndex]")
      .equals([transcriptId, part.index])
      .sortBy("fragmentIndex");
    if (rows.length !== part.fragmentCount) {
      throw new Error(`Audio part ${part.index} is incomplete`);
    }
    rows.forEach((row, index) => {
      if (row.fragmentIndex !== index)
        throw new Error(`Audio part ${part.index} is out of order`);
    });
    return new Blob(
      rows.map((row) => row.blob),
      { type: part.mimeType },
    );
  }

  /** @param {string} transcriptId */
  async function deleteAsset(transcriptId) {
    if (!transcriptId) return;
    await db.transcriptAudioFragments
      .where("transcriptId")
      .equals(transcriptId)
      .delete();
  }

  /** @param {string} transcriptId */
  async function rollbackStaging(transcriptId) {
    await finishStaging(transcriptId);
    await deleteAsset(transcriptId);
  }

  /** @param {number} requestedBytes */
  async function assertStorageHeadroom(requestedBytes) {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (!estimate?.quota || estimate.usage == null) return;
    const available = Math.max(0, estimate.quota - estimate.usage);
    if (Number(requestedBytes) > available * 0.9) {
      throw new DOMException(
        "Not enough browser storage for transcript audio",
        "QuotaExceededError",
      );
    }
  }

  /**
   * Remove only uncommitted assets whose same-origin staging lease is absent
   * or stale. Query unique index keys so startup never loads Blob values.
   * @param {string[]} [protectedTranscriptIds]
   */
  async function reconcileOrphans(protectedTranscriptIds = []) {
    if (!leaseStorage) return;
    const protectedIds = new Set(protectedTranscriptIds.filter(Boolean));
    const transcriptIds = await db.transcriptAudioFragments
      .orderBy("transcriptId")
      .uniqueKeys();
    for (const transcriptIdValue of transcriptIds) {
      const transcriptId = String(transcriptIdValue);
      if (protectedIds.has(transcriptId)) continue;
      const payload = await db.transcriptPayloads.get(transcriptId);
      if (payload?.audioManifest) {
        removeLease(transcriptId);
        continue;
      }
      const lease = readLease(transcriptId);
      if (lease && now() - lease.updatedAt <= leaseStaleMs) continue;
      await deleteAsset(transcriptId);
      removeLease(transcriptId);
    }
  }

  /** @param {string} transcriptId */
  function writeLease(transcriptId) {
    if (!leaseStorage) return false;
    try {
      leaseStorage.setItem(
        leaseKey(transcriptId),
        JSON.stringify({ ownerId, updatedAt: now() }),
      );
      return true;
    } catch {
      leaseStorage = null;
      return false;
    }
  }

  /** @param {string} transcriptId */
  function readLease(transcriptId) {
    if (!leaseStorage) return null;
    try {
      const raw = leaseStorage.getItem(leaseKey(transcriptId));
      if (!raw) return null;
      const lease = JSON.parse(raw);
      if (!lease?.ownerId || !Number.isFinite(Number(lease.updatedAt)))
        return null;
      return {
        ownerId: String(lease.ownerId),
        updatedAt: Number(lease.updatedAt),
      };
    } catch {
      return null;
    }
  }

  /** @param {string} transcriptId */
  function removeLease(transcriptId) {
    if (!leaseStorage) return;
    try {
      leaseStorage.removeItem(leaseKey(transcriptId));
    } catch {
      leaseStorage = null;
    }
  }

  /** @param {string} transcriptId */
  function stopLeaseHeartbeat(transcriptId) {
    const intervalId = leaseIntervals.get(transcriptId);
    if (intervalId !== undefined && typeof cancelInterval === "function")
      cancelInterval(intervalId);
    leaseIntervals.delete(transcriptId);
  }

  return {
    beginStaging,
    finishStaging,
    stageFragment,
    stagePositionedWrite,
    getStagedPartStats,
    getPartBlob,
    deleteAsset,
    rollbackStaging,
    assertStorageHeadroom,
    reconcileOrphans,
  };
}

function resolveLeaseStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function createOwnerId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `audio-owner-${Date.now()}-${Math.random()}`
  );
}

function leaseKey(transcriptId) {
  return `${AUDIO_STAGING_LEASE_PREFIX}${transcriptId}`;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be non-negative`);
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${label} must be positive`);
  return number;
}
