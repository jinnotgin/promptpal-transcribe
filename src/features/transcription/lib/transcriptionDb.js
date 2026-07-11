import Dexie from "dexie";
import {
  buildPayload,
  buildSummary,
  generateRecordId,
} from "@/features/transcription/lib/transcriptHistoryRecords.js";

export const TRANSCRIPTION_DB_NAME = "promptpal-transcription";

/**
 * @typedef {{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }} TranscriptWord
 * @typedef {{ id: string, start: number, end: number, text: string, speaker: string | null, words?: TranscriptWord[] }} TranscriptSegment
 * @typedef {{ cacheKey: string, data: ArrayBuffer, downloadedAt: string, sizeBytes: number }} ModelCacheEntry
 *
 * @typedef {{
 *   id: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   fileName: string,
 *   fileSize: number,
 *   fileDuration: number | null,
 *   isLiveRecording: boolean,
 *   hasReprocessedLiveRecording: boolean,
 *   speakerCount: number,
 *   segmentCount: number,
 *   preview: string,
 * }} TranscriptSummary
 *
 * @typedef {{
 *   id: string,
 *   audioBlob: Blob,
 *   audioMimeType: string,
 *   audioFileName: string,
 *   segments: TranscriptSegment[],
 *   speakerNames: Record<string, string>,
 *   speakerColors: Record<string, string>,
 *   addedSpeakerIds: string[],
 * }} TranscriptPayload
 *
 * @typedef {TranscriptSummary & TranscriptPayload} TranscriptHistoryEntry
 */

/**
 * @typedef {Dexie & {
 *   transcripts: import('dexie').Table<TranscriptSummary, string>
 *   transcriptPayloads: import('dexie').Table<TranscriptPayload, string>
 *   modelCache: import('dexie').Table<ModelCacheEntry, string>
 * }} TranscriptionDb
 */

/** @returns {TranscriptionDb} */
export const createTranscriptionDb = () => {
  const db = /** @type {TranscriptionDb} */ (new Dexie(TRANSCRIPTION_DB_NAME));

  // v1: single full-row transcript history keyed by id (only ever "latest").
  db.version(1).stores({
    transcripts: "&id, createdAt, fileName",
    modelCache: "&cacheKey",
  });

  // v2: multi-record history. Split the heavy audio/segment payload into its
  // own table so listing transcripts only reads lightweight metadata. The
  // legacy single "latest" row is migrated into the new shape.
  db.version(2)
    .stores({
      transcripts: "&id, createdAt",
      transcriptPayloads: "&id",
      modelCache: "&cacheKey",
    })
    .upgrade(async (tx) => {
      const transcripts = tx.table("transcripts");
      const legacy = await transcripts.get("latest");
      if (!legacy) return;

      const id = generateRecordId();
      const segments = Array.isArray(legacy.segments) ? legacy.segments : [];

      await tx.table("transcriptPayloads").put(
        buildPayload({
          id,
          audioBlob: legacy.audioBlob,
          audioMimeType: legacy.audioMimeType,
          audioFileName: legacy.audioFileName ?? legacy.fileName,
          fileName: legacy.fileName,
          segments,
          speakerNames: legacy.speakerNames,
          speakerColors: legacy.speakerColors,
          addedSpeakerIds: legacy.addedSpeakerIds,
        }),
      );

      await transcripts.delete("latest");
      await transcripts.put(
        buildSummary({
          id,
          createdAt: legacy.createdAt,
          updatedAt: legacy.createdAt,
          fileName: legacy.fileName,
          fileSize: legacy.fileSize,
          fileDuration: legacy.fileDuration,
          isLiveRecording: legacy.isLiveRecording,
          hasReprocessedLiveRecording: legacy.hasReprocessedLiveRecording,
          segments,
          addedSpeakerIds: legacy.addedSpeakerIds,
        }),
      );
    });

  return db;
};

/** @type {TranscriptionDb} */
export const db = createTranscriptionDb();
