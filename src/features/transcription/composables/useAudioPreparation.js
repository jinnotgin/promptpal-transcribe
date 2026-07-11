import {
  canDecodeNatively,
  isVideoFile,
  resampleTo16kMono,
  decodeAudioData,
} from "@/features/transcription/lib/audioUtils.js";

/**
 * Orchestrates audio preparation: transcode via FFmpeg worker if needed,
 * then decode and resample to 16kHz mono Float32Array.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useAudioPreparation(store) {
  /** @type {Worker | null} */
  let ffmpegWorker = null;

  /**
   * Prepare a file for ASR: returns 16kHz mono Float32Array.
   * - Native audio formats → Web Audio API decode (fast path)
   * - Video / unsupported audio → FFmpeg worker transcode → decode
   *
   * @param {File} file
   * @returns {Promise<Float32Array>}
   */
  async function prepare(file) {
    const needsFFmpeg = isVideoFile(file) || !canDecodeNatively(file);

    if (needsFFmpeg) {
      const wavBuffer = await transcodeWithFFmpeg(file);
      store.updateProgress("transcoding", 100);
      const audioBuffer = await decodeAudioData(wavBuffer);
      return await resampleTo16kMono(audioBuffer);
    }

    // Fast path: direct decode
    store.updateProgress("transcoding", 30);
    const arrayBuffer = await file.arrayBuffer();
    store.updateProgress("transcoding", 60);
    const audioBuffer = await decodeAudioData(arrayBuffer);
    store.updateProgress("transcoding", 80);
    const pcm = await resampleTo16kMono(audioBuffer);
    store.updateProgress("transcoding", 100);
    return pcm;
  }

  /**
   * Transcode a file to WAV via the FFmpeg worker.
   * @param {File} file
   * @returns {Promise<ArrayBuffer>} WAV data
   */
  function transcodeWithFFmpeg(file) {
    return new Promise(async (resolve, reject) => {
      ffmpegWorker = new Worker(
        new URL("@/workers/ffmpegWorker.js", import.meta.url),
        {
          type: "module",
        },
      );

      ffmpegWorker.onmessage = (e) => {
        const { type, payload } = e.data;
        switch (type) {
          case "progress":
            store.updateProgress("transcoding", payload.percent);
            break;
          case "complete":
            cleanup();
            resolve(payload.wavData);
            break;
          case "error":
            cleanup();
            reject(new Error(payload.message));
            break;
        }
      };

      ffmpegWorker.onerror = (err) => {
        cleanup();
        reject(new Error(`FFmpeg worker error: ${err.message}`));
      };

      try {
        const fileData = await file.arrayBuffer();
        ffmpegWorker.postMessage(
          {
            type: "process",
            payload: { fileData, fileName: file.name },
          },
          [fileData],
        );
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  function cleanup() {
    if (ffmpegWorker) {
      ffmpegWorker.terminate();
      ffmpegWorker = null;
    }
  }

  function abort() {
    if (ffmpegWorker) {
      ffmpegWorker.postMessage({ type: "cancel" });
      cleanup();
    }
  }

  return { prepare, abort };
}
