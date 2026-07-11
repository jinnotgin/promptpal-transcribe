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
   *   audioBlob?: Blob | null,
   *   audioMimeType?: string | null,
   *   audioFileName?: string | null,
   *   segments?: import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[],
   *   speakerNames?: Record<string, string>,
   *   speakerColors?: Record<string, string>,
   *   addedSpeakerIds?: string[],
   * }} entry
   * @returns {Promise<string>}
   */
  async function saveTranscript(entry) {
    if (!entry.segments?.length) {
      throw new Error("Cannot save a transcript with no segments");
    }

    const id = entry.id || generateRecordId();
    const now = new Date().toISOString();
    const existing = entry.id ? await db.transcripts.get(entry.id) : null;
    const createdAt = existing?.createdAt ?? now;

    const summary = buildSummary({ ...entry, id, createdAt, updatedAt: now });
    const payload = buildPayload({ ...entry, id });

    await db.transaction(
      "rw",
      db.transcripts,
      db.transcriptPayloads,
      async () => {
        await db.transcripts.put(summary);
        await db.transcriptPayloads.put(payload);
      },
    );

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
      async () => {
        await db.transcripts.delete(id);
        await db.transcriptPayloads.delete(id);
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
      async () => {
        await db.transcripts.clear();
        await db.transcriptPayloads.clear();
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
