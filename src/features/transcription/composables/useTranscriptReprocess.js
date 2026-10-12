import { ref } from "vue";

/**
 * @typedef {"complete" | "cancelled" | "failed" | "abandoned"} ReprocessStatus
 * @typedef {{ code: string, message: string, recoverable: boolean }} ReprocessError
 */

/**
 * Reprocess one recording without losing its transcript. The transcript is
 * copied first and put back when the reprocess is cancelled or fails. An
 * abandoned reprocess (the user moved to another recording) leaves the store
 * alone, since it now holds a different recording.
 * @param {{
 *   store: any,
 *   pipeline: {
 *     reprocessFromManifest: (transcriptId: string, manifest: any, options: any) => Promise<"complete" | "cancelled" | "failed">,
 *     cancel: () => void,
 *   },
 * }} deps
 */
export function useTranscriptReprocess({ store, pipeline }) {
  const isReprocessing = ref(false);
  let runCount = 0;

  /**
   * @param {string} transcriptId
   * @param {any} manifest
   * @param {any} options
   * @returns {Promise<{ status: ReprocessStatus, error: ReprocessError | null }>}
   */
  async function run(transcriptId, manifest, options) {
    const runId = ++runCount;
    const previous = {
      segments: [...store.segments],
      speakerNames: { ...store.speakerNames },
      speakerColors: { ...store.speakerColors },
      addedSpeakerIds: [...store.addedSpeakerIds],
    };
    isReprocessing.value = true;

    let status;
    try {
      status = await pipeline.reprocessFromManifest(
        transcriptId,
        manifest,
        options,
      );
    } finally {
      if (runId === runCount) isReprocessing.value = false;
    }

    if (runId !== runCount) return { status: "abandoned", error: null };
    if (status === "complete") return { status, error: null };

    const error = status === "failed" ? store.error : null;
    Object.assign(store, previous, { processPhase: "complete", error: null });
    return { status, error };
  }

  /** Stop the reprocess and keep the recording's original transcript. */
  function cancel() {
    if (isReprocessing.value) pipeline.cancel();
  }

  /** Stop the reprocess because the user left its recording. */
  function abandon() {
    if (!isReprocessing.value) return;
    runCount += 1;
    isReprocessing.value = false;
    pipeline.cancel();
  }

  return { isReprocessing, run, cancel, abandon };
}
