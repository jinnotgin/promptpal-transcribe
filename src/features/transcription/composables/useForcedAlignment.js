/**
 * Runs Qwen3-ForcedAligner in a worker to give Chinese transcripts real
 * word timings after Qwen3-ASR has finished (and been unloaded).
 */
export function useForcedAlignment() {
  /** @type {Worker | null} */
  let worker = null;
  let requestSequence = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (reason?: unknown) => void }>} */
  const pending = new Map();

  async function initialize() {
    cleanup();
    worker = new Worker(
      new URL("@/workers/qwenAlignerWorker.js", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = handleMessage;
    worker.onerror = (event) => {
      event?.preventDefault?.();
      failAll(
        new Error(`Aligner worker error: ${event?.message || "unknown"}`),
      );
      cleanup();
    };
    await request("init", {});
  }

  /**
   * @param {Float32Array} pcm the region's audio
   * @param {import('@/features/transcription/lib/alignmentJobs.js').AlignmentJob} job
   * @returns {Promise<Omit<import('@/features/transcription/lib/transcriptionDb').TranscriptSegment, 'id'>[] | null>}
   */
  async function alignRegion(pcm, job) {
    const pcmBuffer = pcm.slice().buffer;
    const payload = await request(
      "align",
      { pcmBuffer, text: job.text, start: job.start, speaker: job.speaker },
      [pcmBuffer],
    );
    return payload.segments ?? null;
  }

  function handleMessage(event) {
    const { type, payload, requestId } = event.data;
    if (type === "model-progress") return;
    if (requestId == null) return;
    const callback = pending.get(requestId);
    if (!callback) return;
    pending.delete(requestId);
    if (type === "error") callback.reject(new Error(payload.message));
    else callback.resolve(payload || {});
  }

  /**
   * @param {string} type
   * @param {unknown} payload
   * @param {Transferable[]} [transfer]
   */
  function request(type, payload, transfer = []) {
    if (!worker)
      return Promise.reject(new Error("Aligner worker is not initialized"));
    const requestId = ++requestSequence;
    const target = worker;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      target.postMessage({ type, requestId, payload }, transfer);
    });
  }

  /** @param {unknown} error */
  function failAll(error) {
    for (const callback of pending.values()) callback.reject(error);
    pending.clear();
  }

  function cleanup() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  function abort() {
    if (worker) worker.postMessage({ type: "cancel" });
    failAll(new DOMException("Aborted", "AbortError"));
    cleanup();
  }

  return { initialize, alignRegion, cleanup, abort };
}
