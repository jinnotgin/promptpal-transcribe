/**
 * Orchestrates bounded audio preparation through one reusable FFmpeg worker.
 *
 */
export function useAudioPreparation() {
  /** @type {Worker | null} */
  let ffmpegWorker = null;
  let requestSequence = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (reason?: unknown) => void }>} */
  const pendingRequests = new Map();

  /**
   * Open one reusable, file-backed FFmpeg session. The original File is
   * structured-cloned to the worker and mounted read-only; it is never turned
   * into a complete ArrayBuffer on the main thread.
   * @param {File} file
   * @param {number | null} [duration]
   */
  async function open(file, duration = null) {
    rejectPending(new DOMException("Superseded", "AbortError"));
    cleanup();
    ffmpegWorker = createWorker();
    return await request("open-file", { file, duration });
  }

  /**
   * @param {{ readStart: number, readEnd: number, index: number, total: number }} window
   * @returns {Promise<Float32Array>}
   */
  async function prepareWindow(window) {
    const payload = await request("prepare-window", {
      start: window.readStart,
      duration: Math.max(0, window.readEnd - window.readStart),
      windowIndex: window.index,
    });
    return new Float32Array(payload.pcmData);
  }

  /**
   * Decode the overlapping ASR window and encode only its committed range as
   * a finalized WebM/Opus review proxy in the same bounded worker request.
   * @param {{ readStart: number, readEnd: number, commitStart: number, commitEnd: number, index: number, total: number }} window
   */
  async function prepareWindowWithProxy(window) {
    const payload = await request("prepare-window-with-proxy", {
      start: window.readStart,
      duration: Math.max(0, window.readEnd - window.readStart),
      commitStart: window.commitStart,
      commitDuration: Math.max(0, window.commitEnd - window.commitStart),
      windowIndex: window.index,
    });
    return {
      pcm: new Float32Array(payload.pcmData),
      proxyBlob: new Blob([payload.proxyData], {
        type: payload.mimeType || "audio/webm;codecs=opus",
      }),
    };
  }

  async function close() {
    if (!ffmpegWorker) return;
    try {
      await request("close-file", {});
    } finally {
      cleanup();
    }
  }

  function createWorker() {
    const worker = new Worker(
      new URL("@/workers/ffmpegWorker.js", import.meta.url),
      {
        type: "module",
      },
    );
    worker.onmessage = (event) => {
      const { type, payload, requestId } = event.data;
      if (requestId == null) return;
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      if (type === "error")
        pending.reject(new Error(payload?.message || "FFmpeg failed"));
      else pending.resolve(payload || {});
    };
    worker.onerror = (error) => {
      const reason = new Error(`FFmpeg worker error: ${error.message}`);
      rejectPending(reason);
      cleanup();
    };
    return worker;
  }

  function request(type, payload) {
    if (!ffmpegWorker)
      return Promise.reject(new Error("FFmpeg session is not open"));
    const requestId = ++requestSequence;
    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      ffmpegWorker.postMessage({ type, requestId, payload });
    });
  }

  function cleanup() {
    if (ffmpegWorker) {
      ffmpegWorker.terminate();
      ffmpegWorker = null;
    }
  }

  function rejectPending(reason) {
    for (const pending of pendingRequests.values()) pending.reject(reason);
    pendingRequests.clear();
  }

  function abort() {
    if (ffmpegWorker) {
      ffmpegWorker.postMessage({ type: "cancel" });
      rejectPending(new DOMException("Aborted", "AbortError"));
      cleanup();
    }
  }

  return { open, prepareWindow, prepareWindowWithProxy, close, abort };
}
