import Dexie from "dexie";
import {
  buildPayload,
  buildSummary,
  generateRecordId,
} from "@/features/transcription/lib/transcriptHistoryRecords.js";
import { inferLegacyLiveRecording } from "@/features/transcription/lib/transcriptSource.js";

/**
 * This app was forked from the PromptPal project and later renamed, so new
 * browsers get a neutral, unbranded database name.
 */
export const TRANSCRIPTION_DB_NAME = "transcription";

/**
 * The name used while this app was part of PromptPal. Browsers that already
 * have it keep using it, so saved transcripts and downloaded models are never
 * stranded and nothing has to be copied. See resolveTranscriptionDbName().
 */
export const LEGACY_TRANSCRIPTION_DB_NAME = "promptpal-transcription";

/**
 * @typedef {{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }} TranscriptWord
 * @typedef {{ id: string, start: number, end: number, text: string, speaker: string | null, words?: TranscriptWord[] }} TranscriptSegment
 * @typedef {{ cacheKey: string, data: ArrayBuffer, downloadedAt: string, sizeBytes: number }} ModelCacheEntry
 * @typedef {import('./transcriptAudioManifest.js').TranscriptAudioManifest} TranscriptAudioManifest
 * @typedef {{ transcriptId: string, partIndex: number, fragmentIndex: number, blob: Blob }} TranscriptAudioFragmentRow
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
 *   language?: import('./engineSelection.js').TranscriptionLanguage,
 *   speakerCount: number,
 *   segmentCount: number,
 *   preview: string,
 * }} TranscriptSummary
 *
 * @typedef {{
 *   id: string,
 *   audioMimeType?: string,
 *   audioFileName?: string,
 *   audioManifest?: TranscriptAudioManifest | null,
 *   segments: TranscriptSegment[],
 *   speakerNames: Record<string, string>,
 *   speakerColors: Record<string, string>,
 *   addedSpeakerIds: string[],
 *   waveformSamples: number[],
 * }} TranscriptPayload
 *
 * @typedef {TranscriptSummary & TranscriptPayload} TranscriptHistoryEntry
 */

/**
 * @typedef {Dexie & {
 *   transcripts: import('dexie').Table<TranscriptSummary, string>
 *   transcriptPayloads: import('dexie').Table<TranscriptPayload, string>
 *   transcriptAudioFragments: import('dexie').Table<TranscriptAudioFragmentRow, [string, number, number]>
 *   modelCache: import('dexie').Table<ModelCacheEntry, string>
 * }} TranscriptionDb
 */

/**
 * @param {string} [name]
 * @returns {TranscriptionDb}
 */
export const createTranscriptionDb = (name = TRANSCRIPTION_DB_NAME) => {
  const db = /** @type {TranscriptionDb} */ (new Dexie(name));

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

  // v3: media bytes are stored as bounded fragment rows and payloads keep a manifest.
  db.version(3).stores({
    transcripts: "&id, createdAt",
    transcriptPayloads: "&id",
    transcriptAudioFragments:
      "[transcriptId+partIndex+fragmentIndex], transcriptId, [transcriptId+partIndex]",
    modelCache: "&cacheKey",
  });

  // v4: legacy single-Blob audio is no longer supported. Preserve transcript
  // content and metadata while releasing the obsolete audio bytes.
  db.version(4)
    .stores({
      transcripts: "&id, createdAt",
      transcriptPayloads: "&id",
      transcriptAudioFragments:
        "[transcriptId+partIndex+fragmentIndex], transcriptId, [transcriptId+partIndex]",
      modelCache: "&cacheKey",
    })
    .upgrade(async (tx) => {
      await tx
        .table("transcriptPayloads")
        .toCollection()
        .modify((payload) => {
          delete payload.audioBlob;
        });
    });

  // v5: the live flag is the only runtime source signal. Backfill it once from
  // each payload's audio manifest so file names never decide it at runtime.
  db.version(5)
    .stores({
      transcripts: "&id, createdAt",
      transcriptPayloads: "&id",
      transcriptAudioFragments:
        "[transcriptId+partIndex+fragmentIndex], transcriptId, [transcriptId+partIndex]",
      modelCache: "&cacheKey",
    })
    .upgrade(async (tx) => {
      const payloads = tx.table("transcriptPayloads");
      const summaries = await tx.table("transcripts").toArray();
      const payloadRows = await payloads.bulkGet(
        summaries.map((summary) => summary.id),
      );
      await tx.table("transcripts").bulkPut(
        summaries.map((summary, index) => ({
          ...summary,
          isLiveRecording: inferLegacyLiveRecording(
            summary,
            payloadRows[index],
          ),
        })),
      );
    });

  return db;
};

/** @type {Promise<string> | undefined} */
let dbNamePromise;

/**
 * Pick the database name once per page load: the legacy PromptPal name if
 * this browser already has that database, otherwise the neutral name.
 * Dexie.exists() aborts its probe for a missing database, so checking never
 * creates the legacy database. Every opener (Dexie history and the raw
 * IndexedDB model cache) must go through here so a new user cannot end up
 * with data split across both names.
 * @returns {Promise<string>}
 */
export function resolveTranscriptionDbName() {
  dbNamePromise ??= Dexie.exists(LEGACY_TRANSCRIPTION_DB_NAME).then(
    (legacyExists) =>
      legacyExists ? LEGACY_TRANSCRIPTION_DB_NAME : TRANSCRIPTION_DB_NAME,
  );
  return dbNamePromise;
}

/** @type {Promise<TranscriptionDb> | undefined} */
let dbPromise;

/** @returns {Promise<TranscriptionDb>} */
export function getTranscriptionDb() {
  dbPromise ??= resolveTranscriptionDbName().then(createTranscriptionDb);
  return dbPromise;
}
