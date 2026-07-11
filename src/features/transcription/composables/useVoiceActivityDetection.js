/**
 * Composable that runs VAD in a dedicated worker.
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useVoiceActivityDetection(store) {
  /** @type {Worker | null} */
  let worker = null;

  /**
   * Detect speech regions in 16kHz mono PCM audio.
   * @param {Float32Array} pcm
   * @returns {Promise<Array<{ start: number, end: number }>>}
   */
  function detect(pcm) {
    return new Promise((resolve, reject) => {
      worker = new Worker(new URL("@/workers/vadWorker.js", import.meta.url), {
        type: "module",
      });

      worker.onmessage = (e) => {
        const { type, payload } = e.data;
        switch (type) {
          case "progress":
            store.updateProgress("vad", payload.percent);
            break;
          case "complete":
            cleanup();
            resolve(payload.regions);
            break;
          case "error":
            cleanup();
            reject(new Error(payload.message));
            break;
        }
      };

      worker.onerror = (err) => {
        cleanup();
        reject(new Error(`VAD worker error: ${err.message}`));
      };

      // Transfer the underlying buffer
      const buffer = pcm.buffer.slice(0);
      worker.postMessage({ type: "process", payload: { pcmData: buffer } }, [
        buffer,
      ]);
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
      cleanup();
    }
  }

  return { detect, abort };
}
