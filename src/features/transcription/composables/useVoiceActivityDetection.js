/**
 * Composable that runs VAD in a dedicated worker.
 */
export function useVoiceActivityDetection() {
  /** @type {Worker | null} */
  let worker = null;
  /** @type {{ worker: Worker, reject: (reason?: unknown) => void } | null} */
  let activeRequest = null;

  /**
   * Detect speech regions in 16kHz mono PCM audio.
   * @param {Float32Array} pcm
   * @returns {Promise<Array<{ start: number, end: number }>>}
   */
  function detect(pcm) {
    return detectBuffer(pcm.buffer.slice(0)).then((result) => result.regions);
  }

  /**
   * Transfer a bounded PCM window to VAD and receive the same buffer back.
   * @param {Float32Array} pcm
   * @returns {Promise<{ regions: Array<{ start: number, end: number, preChunked?: boolean }>, pcm: Float32Array }>}
   */
  function detectWindow(pcm) {
    const buffer =
      pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
        ? pcm.buffer
        : pcm.slice().buffer;
    return detectBuffer(buffer);
  }

  /**
   * @param {ArrayBuffer} buffer
   */
  function detectBuffer(buffer) {
    cancelActive(new DOMException("Superseded", "AbortError"));
    return new Promise((resolve, reject) => {
      const currentWorker = new Worker(
        new URL("@/workers/vadWorker.js", import.meta.url),
        {
          type: "module",
        },
      );
      worker = currentWorker;
      activeRequest = { worker: currentWorker, reject };

      currentWorker.onmessage = (e) => {
        if (activeRequest?.worker !== currentWorker) return;
        const { type, payload } = e.data;
        switch (type) {
          case "complete":
            activeRequest = null;
            cleanup();
            resolve({
              regions: payload.regions,
              pcm: new Float32Array(payload.pcmData),
            });
            break;
          case "error":
            activeRequest = null;
            cleanup();
            reject(new Error(payload.message));
            break;
        }
      };

      currentWorker.onerror = (err) => {
        if (activeRequest?.worker !== currentWorker) return;
        activeRequest = null;
        cleanup();
        reject(new Error(`VAD worker error: ${err.message}`));
      };

      currentWorker.postMessage(
        { type: "process", payload: { pcmData: buffer } },
        [buffer],
      );
    });
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
    }
    cancelActive(new DOMException("Aborted", "AbortError"));
  }

  function cancelActive(reason) {
    const request = activeRequest;
    activeRequest = null;
    request?.reject(reason);
    cleanup();
  }

  return { detect, detectWindow, abort };
}
