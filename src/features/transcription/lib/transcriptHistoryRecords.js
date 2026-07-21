/**
 * Pure helpers for turning an in-progress transcript into the two persisted
 * shapes used by the history store: a lightweight summary (for listing) and a
 * heavy payload (audio + segments + speakers, loaded only when a record opens).
 *
 * Keeping these pure and dependency-free lets both the Dexie migration and the
 * `useTranscriptionHistory` composable share one source of truth, and lets us
 * unit-test the derivation logic without IndexedDB.
 */

import { normalizeWaveformSamples } from "./waveformAccumulator.js";
import { normalizeTranscriptAudioManifest } from "./transcriptAudioManifest.js";

/**
 * @typedef {import('@/features/transcription/lib/transcriptionDb').TranscriptSegment} TranscriptSegment
 * @typedef {import('@/features/transcription/lib/transcriptionDb').TranscriptSummary} TranscriptSummary
 * @typedef {import('@/features/transcription/lib/transcriptionDb').TranscriptPayload} TranscriptPayload
 */

const PREVIEW_MAX_LENGTH = 160;

/**
 * Generate a unique record id. Prefers `crypto.randomUUID()` and falls back to a
 * timestamped random string for older runtimes.
 * @returns {string}
 */
export function generateRecordId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Persist only IndexedDB-cloneable transcript data. Pinia state arrays are
 * reactive proxies, and `structuredClone()` cannot clone Vue proxies.
 * @param {TranscriptSegment[]} [segments]
 * @returns {TranscriptSegment[]}
 */
export function serializeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.map((segment) => ({
    id: String(segment.id),
    start: Number(segment.start),
    end: Number(segment.end),
    text: String(segment.text ?? ""),
    speaker: segment.speaker == null ? null : String(segment.speaker),
    ...(Array.isArray(segment.words)
      ? {
          words: segment.words.map((word) => ({
            text: String(word.text ?? ""),
            start: Number(word.start),
            end: Number(word.end),
            ...(Number.isFinite(Number(word.confidence))
              ? { confidence: Number(word.confidence) }
              : {}),
            ...(Number.isFinite(Number(word.utteranceId))
              ? { utteranceId: Number(word.utteranceId) }
              : {}),
          })),
        }
      : {}),
  }));
}

/**
 * Count the distinct speakers referenced by a transcript, including manually
 * added speaker ids that may not be referenced by any segment yet.
 * @param {TranscriptSegment[]} [segments]
 * @param {string[]} [addedSpeakerIds]
 * @returns {number}
 */
export function countSpeakers(segments, addedSpeakerIds) {
  const ids = new Set();
  if (Array.isArray(segments)) {
    for (const segment of segments) {
      if (segment?.speaker) ids.add(String(segment.speaker));
    }
  }
  if (Array.isArray(addedSpeakerIds)) {
    for (const id of addedSpeakerIds) {
      if (id) ids.add(String(id));
    }
  }
  return ids.size;
}

/**
 * Build a short, single-line text preview from the leading segments.
 * @param {TranscriptSegment[]} [segments]
 * @returns {string}
 */
export function derivePreview(segments) {
  if (!Array.isArray(segments)) return "";
  let preview = "";
  for (const segment of segments) {
    const text = String(segment?.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    preview = preview ? `${preview} ${text}` : text;
    if (preview.length >= PREVIEW_MAX_LENGTH) break;
  }
  if (preview.length <= PREVIEW_MAX_LENGTH) return preview;
  return `${preview.slice(0, PREVIEW_MAX_LENGTH).trimEnd()}…`;
}

/**
 * Build the lightweight summary row stored in the `transcripts` table.
 * @param {{
 *   id: string,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   fileName?: string,
 *   fileSize?: number,
 *   fileDuration?: number | null,
 *   isLiveRecording?: boolean,
 *   hasReprocessedLiveRecording?: boolean,
 *   segments?: TranscriptSegment[],
 *   addedSpeakerIds?: string[],
 * }} entry
 * @returns {TranscriptSummary}
 */
export function buildSummary(entry) {
  const now = new Date().toISOString();
  const segments = Array.isArray(entry.segments) ? entry.segments : [];
  return {
    id: entry.id,
    createdAt: entry.createdAt ?? now,
    updatedAt: entry.updatedAt ?? now,
    fileName: entry.fileName || "Untitled transcript",
    fileSize: Number(entry.fileSize) || 0,
    fileDuration:
      entry.fileDuration == null || !Number.isFinite(Number(entry.fileDuration))
        ? null
        : Number(entry.fileDuration),
    isLiveRecording: Boolean(entry.isLiveRecording),
    hasReprocessedLiveRecording: Boolean(entry.hasReprocessedLiveRecording),
    speakerCount: countSpeakers(segments, entry.addedSpeakerIds),
    segmentCount: segments.length,
    preview: derivePreview(segments),
  };
}

/**
 * Build the heavy payload row stored in the `transcriptPayloads` table.
 * @param {{
 *   id: string,
 *   audioMimeType?: string | null,
 *   audioFileName?: string | null,
 *   audioManifest?: import('./transcriptAudioManifest.js').TranscriptAudioManifest | null,
 *   fileName?: string,
 *   segments?: TranscriptSegment[],
 *   speakerNames?: Record<string, string>,
 *   speakerColors?: Record<string, string>,
 *   addedSpeakerIds?: string[],
 *   waveformSamples?: number[],
 * }} entry
 * @returns {TranscriptPayload}
 */
export function buildPayload(entry) {
  const audioManifest = entry.audioManifest
    ? normalizeTranscriptAudioManifest(entry.audioManifest)
    : null;
  return {
    id: entry.id,
    ...(audioManifest
      ? {
          audioMimeType: entry.audioMimeType ?? audioManifest.parts[0].mimeType,
          audioFileName:
            entry.audioFileName ?? entry.fileName ?? "transcript-audio",
          audioManifest,
        }
      : {}),
    segments: serializeSegments(entry.segments),
    speakerNames: { ...(entry.speakerNames ?? {}) },
    speakerColors: { ...(entry.speakerColors ?? {}) },
    addedSpeakerIds: Array.isArray(entry.addedSpeakerIds)
      ? [...entry.addedSpeakerIds]
      : [],
    waveformSamples: normalizeWaveformSamples(entry.waveformSamples),
  };
}
