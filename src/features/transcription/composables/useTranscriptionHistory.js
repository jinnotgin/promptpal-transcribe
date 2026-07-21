import { db } from "@/features/transcription/lib/transcriptionDb.js";
import {
  buildPayload,
  buildSummary,
  generateRecordId,
} from "@/features/transcription/lib/transcriptHistoryRecords.js";

/**
 * @typedef {import('@/features/transcription/lib/transcriptionDb').TranscriptSummary} TranscriptSummary
 * @typedef {import('@/features/transcription/lib/transcriptionDb').TranscriptHistoryEntry} TranscriptHistoryEntry
 */

/**
 * Multi-record local history for completed transcripts. Metadata lives in the
 * `transcripts` table; the heavy audio + segment payload lives in
 * `transcriptPayloads` and is only read when a record is opened.
 */
export function useTranscriptionHistory() {
  /**
   * List saved transcripts newest-first. Reads metadata only (no audio blobs).
   * @returns {Promise<TranscriptSummary[]>}
   */
  async function listSummaries() {
    return db.transcripts.orderBy("createdAt").reverse().toArray();
  }

  /**
   * Load the full record (metadata + payload) for a single transcript.
   * @param {string} id
   * @returns {Promise<TranscriptHistoryEntry | null>}
   */
  async function loadTranscript(id) {
    if (!id) return null;
    const [summary, payload] = await Promise.all([
      db.transcripts.get(id),
      db.transcriptPayloads.get(id),
    ]);
    if (!summary || !payload) return null;
    return /** @type {TranscriptHistoryEntry} */ ({ ...summary, ...payload });
  }

  /**
   * Create or update a transcript record. Pass an existing `id` to update in
   * place (preserving the original `createdAt`); omit it to create a new
   * record. Returns the record id.
   * @param {{
   *   id?: string | null,
   *   fileName?: string,
   *   fileSize?: number,
   *   fileDuration?: number | null,
   *   isLiveRecording?: boolean,
   *   hasReprocessedLiveRecording?: boolean,
   *   audioMimeType?: string | null,
   *   audioFileName?: string | null,
   *   audioManifest?: import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest | null,
   *   segments?: import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[],
   *   speakerNames?: Record<string, string>,
   *   speakerColors?: Record<string, string>,
   *   addedSpeakerIds?: string[],
   *   waveformSamples?: number[],
   * }} entry
   * @param {{ finalizeAudio?: boolean }} [options]
   * @returns {Promise<string>}
   */
  async function saveTranscript(entry, options = {}) {
    if (!entry.segments?.length) {
      throw new Error("Cannot save a transcript with no segments");
    }

    const id = entry.id || generateRecordId();
    const now = new Date().toISOString();
    const existing = entry.id ? await db.transcripts.get(entry.id) : null;
    const createdAt = existing?.createdAt ?? now;

    const summary = buildSummary({ ...entry, id, createdAt, updatedAt: now });
    const payload = buildPayload({ ...entry, id });

    if (options.finalizeAudio && payload.audioManifest) {
      await db.transaction(
        "rw",
        db.transcripts,
        db.transcriptPayloads,
        db.transcriptAudioFragments,
        async () => {
          await validateManifestAsset(id, payload.audioManifest);
          await db.transcripts.put(summary);
          await db.transcriptPayloads.put(payload);
        },
      );
    } else {
      await db.transaction(
        "rw",
        db.transcripts,
        db.transcriptPayloads,
        async () => {
          await db.transcripts.put(summary);
          await db.transcriptPayloads.put(payload);
        },
      );
    }

    return id;
  }

  /**
   * Delete a single transcript record (metadata + payload).
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteTranscript(id) {
    if (!id) return;
    await db.transaction(
      "rw",
      db.transcripts,
      db.transcriptPayloads,
      db.transcriptAudioFragments,
      async () => {
        await db.transcripts.delete(id);
        await db.transcriptPayloads.delete(id);
        await db.transcriptAudioFragments
          .where("transcriptId")
          .equals(id)
          .delete();
      },
    );
  }

  /**
   * Delete every saved transcript.
   * @returns {Promise<void>}
   */
  async function deleteAll() {
    await db.transaction(
      "rw",
      db.transcripts,
      db.transcriptPayloads,
      db.transcriptAudioFragments,
      async () => {
        await db.transcripts.clear();
        await db.transcriptPayloads.clear();
        await db.transcriptAudioFragments.clear();
      },
    );
  }

  return {
    listSummaries,
    loadTranscript,
    saveTranscript,
    deleteTranscript,
    deleteAll,
  };
}

/**
 * Validate staged v3 rows inside the same transaction that makes their
 * manifest durable. Blob bytes are not copied; only row order and Blob sizes
 * are inspected.
 * @param {string} transcriptId
 * @param {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest} manifest
 */
async function validateManifestAsset(transcriptId, manifest) {
  for (const part of manifest.parts) {
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
    const sizeBytes = rows.reduce((total, row) => total + row.blob.size, 0);
    if (sizeBytes !== part.sizeBytes) {
      throw new Error(
        `Audio part ${part.index} byte size does not match its manifest`,
      );
    }
  }
}
