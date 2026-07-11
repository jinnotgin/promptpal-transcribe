/**
 * Voice Activity Detection worker.
 *
 * Messages:
 *   Main → Worker:
 *     { type: "process", payload: { pcmData: ArrayBuffer } }
 *     { type: "cancel" }
 *
 *   Worker → Main:
 *     { type: "progress", payload: { percent: number } }
 *     { type: "complete", payload: { regions: Array<{ start: number, end: number }> } }
 *     { type: "error", payload: { code: string, message: string } }
 */

import { detectSpeechRegions } from "@/features/transcription/lib/vadSignal.js";

let cancelled = false;

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case "process": {
      cancelled = false;
      try {
        const pcm = new Float32Array(payload.pcmData);
        const regions = await detectSpeechRegions(pcm, (percent) => {
          if (!cancelled) {
            self.postMessage({ type: "progress", payload: { percent } });
          }
        });

        if (!cancelled) {
          self.postMessage({ type: "complete", payload: { regions } });
        }
      } catch (err) {
        if (!cancelled) {
          self.postMessage({
            type: "error",
            payload: {
              code: "VAD_FAILED",
              message: err?.message || String(err),
            },
          });
        }
      }
      break;
    }
    case "cancel":
      cancelled = true;
      break;
  }
};
