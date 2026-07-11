import { ref } from "vue";
import { v4 as uuidv4 } from "uuid";
import { useModelManager } from "./useModelManager.js";
import { useAsrInference } from "./useAsrInference.js";
import { useMicrophoneCapture } from "./useMicrophoneCapture.js";
import {
  rebuildSegmentsFromWords,
  mergeAdjacentSegments,
} from "@/features/transcription/lib/timestampStitching.js";
import { trackAnalyticsEvent } from "@/lib/eventSignals.js";
import { SYSTEM_DEFAULT_MIC_ID } from "@/features/transcription/composables/useMicrophoneDevices.js";

/**
 * Orchestrator for live microphone transcription.
 * Captures mic audio → streams through live VAD → sends completed
 * utterances to the existing ASR worker → appends segments to the store.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useLivePipeline(store) {
  const modelManager = useModelManager(store);
  const asr = useAsrInference(store);

  /** @type {Worker | null} */
  let vadWorker = null;
  /** @type {ReturnType<typeof useMicrophoneCapture> | null} */
  let mic = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let elapsedInterval = null;
  let sessionStartTime = 0;
  let pausedAt = 0;
  let totalPausedMs = 0;
  let utteranceQueue = Promise.resolve();

  /** @type {Float32Array[]} */
  let pcmChunks = [];
  /** Merged PCM from the completed live session, available after stop(). */
  const capturedPcm = ref(/** @type {Float32Array | null} */ (null));

  /**
   * Start a live transcription session.
   * Downloads/loads ASR model, starts mic capture, and begins streaming.
   */
  async function start() {
    store.clearProcessingState();
    store.segments = [];
    store.speakerNames = {};
    store.speakerColors = {};
    store.error = null;
    store.liveElapsed = 0;
    store.fileName = `Live Recording ${new Date().toLocaleString()}`;
    pcmChunks = [];
    capturedPcm.value = null;

    const runtime = store.effectiveRuntime;

    trackAnalyticsEvent("live_transcription_started", { runtime });

    try {
      store.processPhase = "checking-cache";
      await modelManager.checkCache();
      await asr.initialize(runtime);

      if (store.isCancelled) throw abortError();

      vadWorker = new Worker(
        new URL("@/workers/liveVadWorker.js", import.meta.url),
        {
          type: "module",
        },
      );

      await initVadWorker(vadWorker);

      vadWorker.onmessage = (e) => handleVadMessage(e.data);
      vadWorker.onerror = (err) => {
        handleError(new Error(`VAD worker error: ${err.message}`));
      };

      mic = createMicrophoneCapture();

      await mic.start({ deviceId: selectedCaptureDeviceId() });

      store.processPhase = "transcribing";
      store.setMicInputState("ready");
      store.setMicInputError(null);
      sessionStartTime = Date.now();
      pausedAt = 0;
      totalPausedMs = 0;
      elapsedInterval = setInterval(() => {
        if (!store.isPaused) {
          store.liveElapsed = Math.floor(
            (Date.now() - sessionStartTime - totalPausedMs) / 1000,
          );
        }
      }, 1000);
    } catch (err) {
      if (err?.name === "AbortError" || store.isCancelled) {
        cleanup();
        store.clearProcessingState();
        store.clearLiveState();
        return;
      }
      handleError(err);
    }
  }

  function pause() {
    mic?.pause();
    pausedAt = Date.now();
  }

  function resume() {
    if (!store.selectedMicAvailable || store.micInputState === "interrupted") {
      store.setMicInputState("unavailable");
      store.setMicInputError({
        code: "MIC_UNAVAILABLE",
        message:
          "Selected microphone is unavailable. Choose another input to resume.",
        recoverable: true,
      });
      return;
    }
    if (pausedAt > 0) {
      totalPausedMs += Date.now() - pausedAt;
      pausedAt = 0;
    }
    mic?.resume();
  }

  async function switchInput(deviceId) {
    const previousMicId = store.selectedMicId;
    const previousMicLabel = store.selectedMicLabel;
    store.selectMicrophone(deviceId);
    if (!store.isListening || !mic) {
      return;
    }

    const wasPaused = store.isPaused;
    store.setMicInputState("switching");
    store.setMicInputError(null);

    try {
      await mic.switchDevice({
        deviceId: selectedCaptureDeviceId(),
      });
      if (wasPaused) {
        store.isPaused = true;
      }
      store.setMicInputState("ready");
    } catch (err) {
      store.selectMicrophone(previousMicId);
      store.selectedMicLabel = previousMicLabel;
      store.setMicInputState(
        store.selectedMicAvailable ? "ready" : "unavailable",
      );
      store.setMicInputError({
        code: "MIC_SWITCH_FAILED",
        message:
          "Could not switch microphones. Still using the previous microphone if it is available.",
        recoverable: true,
      });
      throw err;
    }
  }

  async function retryInput() {
    if (!store.isListening || !mic) return;
    await switchInput(store.selectedMicId);
  }

  async function stop() {
    if (vadWorker) {
      vadWorker.postMessage({ type: "flush" });
      await new Promise((r) => setTimeout(r, 200));
    }

    await utteranceQueue;

    cleanup();

    // Merge accumulated PCM for potential reprocessing
    if (pcmChunks.length > 0) {
      const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of pcmChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      capturedPcm.value = merged;
      pcmChunks = []; // free chunk references
    }

    if (store.segments.length > 0) {
      store.fileDuration = store.liveElapsed;
      store.processPhase = "complete";
      trackAnalyticsEvent("live_transcription_completed", {
        durationSec: store.liveElapsed,
        segmentCount: store.segments.length,
      });
    } else {
      store.processPhase = "idle";
    }

    store.clearLiveState();
  }

  function cancel() {
    store.isCancelled = true;
    cleanup();
    pcmChunks = [];
    capturedPcm.value = null;
    store.clearProcessingState();
    store.clearLiveState();
    trackAnalyticsEvent("live_transcription_cancelled");
  }

  /** Discard the captured PCM to free memory. */
  function discardCapturedPcm() {
    pcmChunks = [];
    capturedPcm.value = null;
  }

  function handleVadMessage(data) {
    switch (data.type) {
      case "speech-start":
        break;

      case "speech-end": {
        const utteranceAudio = new Float32Array(data.utterance);
        const uttStart = data.start;
        const uttEnd = data.end;
        utteranceQueue = utteranceQueue.then(() =>
          transcribeUtterance(utteranceAudio, uttStart, uttEnd),
        );
        break;
      }

      case "error":
        handleError(new Error(data.payload?.message || "VAD error"));
        break;
    }
  }

  async function transcribeUtterance(audio, uttStart, uttEnd) {
    if (store.isCancelled || !store.isListening) return;

    try {
      const rawSegments = await asr.processChunk(audio, uttStart, 0, 1);
      if (!rawSegments.length) return;

      const merged = mergeAdjacentSegments(
        rebuildSegmentsFromWords(rawSegments),
        1.25,
      );

      const withIds = merged.map((seg) => ({
        ...seg,
        id: seg.id || uuidv4(),
        speaker: null,
      }));

      store.segments = [...store.segments, ...withIds];
    } catch (err) {
      if (err?.name !== "AbortError" && !store.isCancelled) {
        console.error("[live-transcription] utterance ASR error:", err);
      }
    }
  }

  function initVadWorker(worker) {
    return new Promise((resolve, reject) => {
      const onMessage = (e) => {
        if (e.data.type === "ready") {
          worker.removeEventListener("message", onMessage);
          resolve();
        } else if (e.data.type === "error") {
          worker.removeEventListener("message", onMessage);
          reject(new Error(e.data.payload?.message || "VAD init failed"));
        }
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ type: "init" });
    });
  }

  function cleanup() {
    if (elapsedInterval != null) {
      clearInterval(elapsedInterval);
      elapsedInterval = null;
    }
    mic?.stop();
    mic = null;
    if (vadWorker) {
      vadWorker.postMessage({ type: "cancel" });
      vadWorker.terminate();
      vadWorker = null;
    }
    asr.cleanup();
  }

  function createMicrophoneCapture() {
    return useMicrophoneCapture(
      store,
      (pcm) => {
        if (
          vadWorker &&
          !store.isPaused &&
          store.micInputState !== "interrupted"
        ) {
          // Clone before transfer so we can accumulate for reprocessing
          pcmChunks.push(new Float32Array(pcm));
          const buffer = pcm.buffer.byteLength
            ? pcm.buffer
            : pcm.slice().buffer;
          vadWorker.postMessage({ type: "feed", pcm: buffer }, [buffer]);
        }
      },
      { onEnded: handleMicrophoneEnded },
    );
  }

  function handleMicrophoneEnded() {
    if (!store.isListening || store.isCancelled) return;
    mic?.interrupt();
    store.isPaused = false;
    store.setMicInputState("interrupted");
    store.setMicInputError({
      code: "MIC_DISCONNECTED",
      message: `${store.selectedMicLabel || "Selected microphone"} disconnected. Choose an input to continue.`,
      recoverable: true,
    });
  }

  function handleError(err) {
    console.error("[live-transcription] error:", err);
    cleanup();
    store.clearLiveState();
    store.processPhase = "error";
    store.error = classifyLiveError(err);
    trackAnalyticsEvent("live_transcription_failed", {
      errorCode: store.error.code,
    });
  }

  function abortError() {
    cleanup();
    return new DOMException("Aborted", "AbortError");
  }

  function selectedCaptureDeviceId() {
    return store.selectedMicId && store.selectedMicId !== SYSTEM_DEFAULT_MIC_ID
      ? store.selectedMicId
      : null;
  }

  return {
    start,
    pause,
    resume,
    stop,
    cancel,
    switchInput,
    retryInput,
    capturedPcm,
    discardCapturedPcm,
  };
}

function classifyLiveError(err) {
  const msg = err.message || String(err);

  if (msg.includes("MIC_PERMISSION_DENIED")) {
    return {
      code: "MIC_PERMISSION_DENIED",
      message:
        "Microphone access was denied. Please allow microphone permission and try again.",
      recoverable: true,
    };
  }
  if (msg.includes("MIC_UNAVAILABLE")) {
    return {
      code: "MIC_UNAVAILABLE",
      message:
        "Could not access the microphone. Make sure a microphone is connected and not in use by another app.",
      recoverable: true,
    };
  }
  if (msg.includes("VAD")) {
    return {
      code: "VAD_FAILED",
      message: "Speech detection failed during live transcription.",
      recoverable: true,
    };
  }
  if (msg.includes("ASR") || msg.includes("onnx") || msg.includes("ONNX")) {
    return {
      code: "ASR_FAILED",
      message:
        "Transcription model failed. Try switching the runtime in settings.",
      recoverable: true,
    };
  }
  if (
    msg.includes("download") ||
    msg.includes("fetch") ||
    msg.includes("network")
  ) {
    return {
      code: "DOWNLOAD_FAILED",
      message:
        "Model download failed. Check your internet connection and try again.",
      recoverable: true,
    };
  }

  return {
    code: "UNKNOWN",
    message: msg || "An unexpected error occurred during live transcription.",
    recoverable: true,
  };
}
