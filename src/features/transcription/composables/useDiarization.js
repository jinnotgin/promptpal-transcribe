import { assignSpeakersToSegments } from "@/features/transcription/lib/speakerAssignment.js";

const ENABLE_TRANSCRIPTION_DIAGNOSTICS = import.meta.env.DEV;

/**
 * Runs lightweight local diarization in a worker and assigns speaker labels.
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useDiarization(store) {
  /** @type {Worker | null} */
  let worker = null;

  /**
   * @param {Float32Array} pcm
   * @param {import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]} segments
   * @returns {Promise<import('@/features/transcription/lib/transcriptionDb').TranscriptSegment[]>}
   */
  function diarize(pcm, segments) {
    return new Promise((resolve, reject) => {
      worker = new Worker(
        new URL("@/workers/diarizationWorker.js", import.meta.url),
        {
          type: "module",
        },
      );

      worker.onmessage = (e) => {
        const { type, payload } = e.data;
        switch (type) {
          case "progress":
            store.updateProgress("diarization", payload.percent);
            break;
          case "model-progress":
            if (payload.percent != null) {
              store.sortformerLoadProgress = payload.percent;
            }
            break;
          case "complete":
            logDiarizationDiagnostics(payload.diagnostics);
            cleanup();
            resolve(
              payload.segments ||
                assignSpeakersToSegments(segments, payload.assignments || []),
            );
            break;
          case "error":
            cleanup();
            reject(new Error(payload.message));
            break;
        }
      };

      worker.onerror = (err) => {
        console.error("[transcription][diarization-worker] onerror", {
          message: err?.message,
          filename: err?.filename,
          lineno: err?.lineno,
          colno: err?.colno,
          error: err?.error,
          type: err?.type,
        });
        err?.preventDefault?.();
        cleanup();
        reject(
          new Error(`Diarization worker error: ${describeWorkerError(err)}`),
        );
      };

      worker.onmessageerror = (err) => {
        console.error("[transcription][diarization-worker] messageerror", err);
        cleanup();
        reject(
          new Error(
            `Diarization worker message error: ${describeWorkerError(err)}`,
          ),
        );
      };

      const pcmBuffer = pcm.buffer;
      worker.postMessage(
        {
          type: "process",
          payload: {
            pcmBuffer,
            segments: segments.map((segment) => ({ ...segment })),
            runtime: store.effectiveRuntime,
          },
        },
        [pcmBuffer],
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
      cleanup();
    }
  }

  return { diarize, abort };
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
