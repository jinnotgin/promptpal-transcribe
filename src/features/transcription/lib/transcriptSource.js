/**
 * Decide whether a transcript came from the live microphone or an upload.
 *
 * The audio manifest records where its media came from when it is captured,
 * and the summary keeps an explicit `isLiveRecording` flag. File names are
 * user-facing and never decide the source: an upload can be named
 * "Live Recording…" and a reprocessed live recording can carry any name.
 */

/**
 * @typedef {{
 *   isLiveRecording?: boolean,
 *   audioManifest?: { source?: string } | null,
 * }} TranscriptSourceRecord
 */

/**
 * @param {TranscriptSourceRecord | null | undefined} record
 * @returns {boolean}
 */
export function isLiveTranscript(record) {
  if (!record) return false;
  return (
    record.audioManifest?.source === "live" || Boolean(record.isLiveRecording)
  );
}

const LEGACY_LIVE_FILE_NAME = /^Live Recording\b/;
const LEGACY_LIVE_AUDIO_FILE_NAME = "live-recording";

/**
 * One-time backfill for rows saved before the live flag was reliable. Used
 * only by the database migration, never at runtime. When audio exists its
 * manifest decides; the old naming convention is consulted only for rows with
 * no audio left to classify them by.
 * @param {{ fileName?: string, isLiveRecording?: boolean } | null | undefined} summary
 * @param {{ audioFileName?: string, audioManifest?: { source?: string } | null } | null | undefined} payload
 * @returns {boolean}
 */
export function inferLegacyLiveRecording(summary, payload) {
  const manifestSource = payload?.audioManifest?.source;
  if (manifestSource === "live" || manifestSource === "upload") {
    return manifestSource === "live";
  }
  if (summary?.isLiveRecording) return true;
  return (
    payload?.audioFileName === LEGACY_LIVE_AUDIO_FILE_NAME ||
    LEGACY_LIVE_FILE_NAME.test(summary?.fileName || "")
  );
}
