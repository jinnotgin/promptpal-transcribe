const ENABLE_TRANSCRIPTION_DIAGNOSTICS = import.meta.env.DEV;

/**
 * Runs lightweight local diarization in a worker and assigns speaker labels.
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useDiarization(store) {
  /** @type {Worker | null} */
  let worker = null;
  let requestSequence = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (reason?: unknown) => void }>} */
  const pending = new Map();

  /** @param {'webgpu' | 'wasm'} runtime */
  async function initialize(runtime) {
    cleanup();
    worker = new Worker(
      new URL("@/workers/diarizationWorker.js", import.meta.url),
      {
        type: "module",
      },
    );
    worker.onmessage = handleMessage;
    worker.onerror = handleWorkerError;
    worker.onmessageerror = handleMessageError;
    await request("init", { runtime });
  }

  /**
   * @param {Float32Array} pcm
   * @param {{ windowIndex: number, totalWindows: number }} options
   */
  async function processWindow(pcm, options) {
    const pcmBuffer = pcm.buffer;
    await request("process-window", { pcmBuffer, ...options }, [pcmBuffer]);
  }

  /**
   * @param {import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]} segments
   */
  async function finalize(segments) {
    try {
      const payload = await request("finalize", {
        segments: segments.map((segment) => ({ ...segment })),
      });
      logDiarizationDiagnostics(payload.diagnostics);
      return payload.segments || segments;
    } finally {
      cleanup();
    }
  }

  /**
   * @param {Float32Array} pcm
   * @param {import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]} segments
   * @returns {Promise<import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]>}
   */
  async function diarize(pcm, segments) {
    await initialize(store.effectiveRuntime);
    await processWindow(pcm, { windowIndex: 0, totalWindows: 1 });
    return await finalize(segments);
  }

  function handleMessage(event) {
    const { type, payload, requestId } = event.data;
    if (type === "progress") {
      store.updateProgress("diarization", payload.percent);
      return;
    }
    if (type === "model-progress") {
      if (payload.percent != null)
        store.sortformerLoadProgress = payload.percent;
      return;
    }
    if (requestId == null) return;
    const callback = pending.get(requestId);
    if (!callback) return;
    pending.delete(requestId);
    if (type === "error") callback.reject(new Error(payload.message));
    else callback.resolve(payload || {});
  }

  function handleWorkerError(err) {
    console.error("[transcription][diarization-worker] onerror", err);
    err?.preventDefault?.();
    failAll(new Error(`Diarization worker error: ${describeWorkerError(err)}`));
    cleanup();
  }

  function handleMessageError(err) {
    console.error("[transcription][diarization-worker] messageerror", err);
    failAll(
      new Error(
        `Diarization worker message error: ${describeWorkerError(err)}`,
      ),
    );
    cleanup();
  }

  function request(type, payload, transfer = []) {
    if (!worker)
      return Promise.reject(new Error("Diarization worker is not initialized"));
    const requestId = ++requestSequence;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      worker.postMessage({ type, requestId, payload }, transfer);
    });
  }

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
    if (worker) {
      worker.postMessage({ type: "cancel" });
      failAll(new DOMException("Aborted", "AbortError"));
      cleanup();
    }
  }

  return { initialize, processWindow, finalize, diarize, abort };
}

/**
 * @param {unknown} diagnostics
 */
function logDiarizationDiagnostics(diagnostics) {
  if (
    !ENABLE_TRANSCRIPTION_DIAGNOSTICS ||
    typeof console === "undefined" ||
    !diagnostics
  )
    return;
  console.info("[transcription][diarization]", diagnostics);
}

/**
 * @param {unknown} err
 */
function describeWorkerError(err) {
  const event =
    /** @type {{ message?: string, filename?: string, lineno?: number, colno?: number, error?: unknown, type?: string }} */ (
      err
    );
  const nestedError = event.error instanceof Error ? event.error : null;
  const nestedMessage = nestedError
    ? nestedError.message || nestedError.name
    : event.error
      ? String(event.error)
      : "";
  const baseMessage =
    event.message || nestedMessage || event.type || "unknown worker error";
  const location = event.filename
    ? ` (${event.filename}:${event.lineno || 0}:${event.colno || 0})`
    : "";
  const stack = nestedError?.stack ? `\n${nestedError.stack}` : "";
  return `${baseMessage}${location}${stack}`;
}
