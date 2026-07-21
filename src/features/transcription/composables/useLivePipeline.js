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
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";
import { selectLiveRecordingProfile } from "@/features/transcription/lib/mediaRecorderProfile.js";
import { normalizeTranscriptAudioManifest } from "@/features/transcription/lib/transcriptAudioManifest.js";
import { createLiveWaveformAccumulator } from "@/features/transcription/lib/liveWaveformAccumulator.js";

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
  const audioAssets = useTranscriptionAudioAssets();

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

  const audioManifest = ref(
    /** @type {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest | null} */ (
      null
    ),
  );
  const audioPersistenceError = ref(/** @type {Error | null} */ (null));
  let waveform = createLiveWaveformAccumulator();
  let recordingTranscriptId = null;
  let recorderProfile = null;
  /** @type {MediaRecorder | null} */
  let mediaRecorder = null;
  /** @type {Array<import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioPart>} */
  let mediaParts = [];
  let currentPart = null;
  let fragmentWriteQueue = Promise.resolve();
  let pendingFragmentWrites = 0;
  let audioRecordingDisabled = false;
  const MAX_PENDING_FRAGMENT_WRITES = 8;
  const MEDIA_RECORDER_TIMESLICE_MS = 10_000;

  /**
   * Start a live transcription session.
   * Downloads/loads ASR model, starts mic capture, and begins streaming.
   */
  async function start(options = {}) {
    store.clearProcessingState();
    store.segments = [];
    store.speakerNames = {};
    store.speakerColors = {};
    store.error = null;
    store.liveElapsed = 0;
    store.fileName = `Live Recording ${new Date().toLocaleString()}`;
    recordingTranscriptId = options.transcriptId || null;
    audioManifest.value = null;
    mediaParts = [];
    currentPart = null;
    fragmentWriteQueue = Promise.resolve();
    pendingFragmentWrites = 0;
    audioRecordingDisabled = false;
    waveform = createLiveWaveformAccumulator();
    recorderProfile = null;
    audioPersistenceError.value = null;

    const runtime = store.effectiveRuntime;

    trackAnalyticsEvent("live_transcription_started", { runtime });

    try {
      if (recordingTranscriptId)
        await audioAssets.beginStaging(recordingTranscriptId);
      recorderProfile = recordingTranscriptId
        ? selectLiveRecordingProfile()
        : null;
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
        if (!store.isPaused && pausedAt === 0) {
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

  async function pause() {
    pausedAt = Date.now();
    try {
      await mic?.pause();
      if (mediaRecorder?.state === "recording") mediaRecorder.pause();
    } catch (error) {
      // The capture graph disables its tracks before requesting the tail
      // flush. Keep transcription paused and fall back to text-only history
      // if that final audio buffer cannot be committed safely.
      store.isPaused = true;
      store.micLevel = 0;
      try {
        await disableAudioPersistence(error);
      } catch {
        // The original flush failure remains available to the UI.
      }
    }
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
    if (mediaRecorder?.state === "paused") mediaRecorder.resume();
  }

  async function switchInput(deviceId) {
    const previousMicId = store.selectedMicId;
    const previousMicLabel = store.selectedMicLabel;
    const previousInputState = store.micInputState;
    store.selectMicrophone(deviceId);
    if (!store.isListening || !mic) {
      return;
    }

    const wasPaused = store.isPaused;
    const switchStartedAt = Date.now();
    if (!wasPaused && pausedAt === 0) pausedAt = switchStartedAt;
    store.setMicInputState("switching");
    store.setMicInputError(null);

    try {
      await finishMediaPart(currentActiveSeconds());
      await mic.switchDevice({
        deviceId: selectedCaptureDeviceId(),
      });
      if (wasPaused) {
        store.isPaused = true;
        if (mediaRecorder?.state === "recording") mediaRecorder.pause();
      } else {
        totalPausedMs += Date.now() - pausedAt;
        pausedAt = 0;
      }
      store.setMicInputState("ready");
    } catch (err) {
      if (!wasPaused && previousInputState !== "interrupted") {
        totalPausedMs += Date.now() - pausedAt;
        pausedAt = 0;
      }
      const previousStream = mic.getStream?.();
      if (
        previousInputState !== "interrupted" &&
        previousStream &&
        !mediaRecorder
      ) {
        beginMediaPart(previousStream);
      }
      if (wasPaused && mediaRecorder?.state === "recording")
        mediaRecorder.pause();
      store.selectMicrophone(previousMicId);
      store.selectedMicLabel = previousMicLabel;
      store.setMicInputState(
        previousInputState === "interrupted"
          ? "interrupted"
          : store.selectedMicAvailable
            ? "ready"
            : "unavailable",
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
    try {
      await finishMediaPart(currentActiveSeconds());
      await fragmentWriteQueue;
      await mic?.flushAndStop?.({ updateStore: false });
    } catch (error) {
      audioPersistenceError.value =
        error instanceof Error
          ? error
          : new Error("Could not save recording audio");
      audioManifest.value = null;
      if (recordingTranscriptId)
        await audioAssets.rollbackStaging(recordingTranscriptId);
    }
    if (vadWorker) {
      vadWorker.postMessage({ type: "flush" });
      await new Promise((r) => setTimeout(r, 200));
    }

    await utteranceQueue;

    cleanup();

    if (store.segments.length > 0) {
      store.fileDuration = Math.max(
        currentActiveSeconds(),
        mediaParts.at(-1)?.end || 0,
      );
      store.waveformSamples = waveform.finalize();
      if (
        recordingTranscriptId &&
        mediaParts.length &&
        !audioRecordingDisabled
      ) {
        audioManifest.value = normalizeTranscriptAudioManifest({
          version: 1,
          duration: Math.max(
            currentActiveSeconds(),
            mediaParts.at(-1)?.end || 0,
          ),
          source: "live",
          parts: mediaParts,
        });
      }
      store.processPhase = "complete";
      trackAnalyticsEvent("live_transcription_completed", {
        durationSec: store.liveElapsed,
        segmentCount: store.segments.length,
      });
    } else {
      audioManifest.value = null;
      if (recordingTranscriptId)
        await audioAssets.rollbackStaging(recordingTranscriptId);
      store.processPhase = "idle";
    }

    store.clearLiveState();
  }

  function cancel() {
    const transcriptId = recordingTranscriptId;
    const pendingWrites = fragmentWriteQueue;
    store.isCancelled = true;
    stopRecorderImmediately();
    cleanup();
    if (transcriptId) {
      void pendingWrites
        .finally(() => audioAssets.rollbackStaging(transcriptId))
        .catch(() => {});
    }
    audioManifest.value = null;
    store.clearProcessingState();
    store.clearLiveState();
    trackAnalyticsEvent("live_transcription_cancelled");
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
          waveform.addChunk(pcm);
          const buffer = pcm.buffer.byteLength
            ? pcm.buffer
            : pcm.slice().buffer;
          vadWorker.postMessage({ type: "feed", pcm: buffer }, [buffer]);
        }
      },
      { onEnded: handleMicrophoneEnded, onStreamReady: beginMediaPart },
    );
  }

  async function handleMicrophoneEnded() {
    if (!store.isListening || store.isCancelled) return;
    const interruptionTime = currentActiveSeconds();
    if (pausedAt === 0) pausedAt = Date.now();
    try {
      await finishMediaPart(interruptionTime);
      await mic?.interrupt();
    } catch (error) {
      await disableAudioPersistence(error);
    }
    store.isPaused = false;
    store.setMicInputState("interrupted");
    store.setMicInputError({
      code: "MIC_DISCONNECTED",
      message: `${store.selectedMicLabel || "Selected microphone"} disconnected. Choose an input to continue.`,
      recoverable: true,
    });
  }

  function handleError(err) {
    const transcriptId = recordingTranscriptId;
    const pendingWrites = fragmentWriteQueue;
    console.error("[live-transcription] error:", err);
    cleanup();
    stopRecorderImmediately();
    if (transcriptId) {
      void pendingWrites
        .finally(() => audioAssets.rollbackStaging(transcriptId))
        .catch(() => {});
    }
    store.clearLiveState();
    store.processPhase = "error";
    store.error = classifyLiveError(err);
    trackAnalyticsEvent("live_transcription_failed", {
      errorCode: store.error.code,
    });
  }

  /** @param {MediaStream} stream */
  function beginMediaPart(stream) {
    if (
      !recordingTranscriptId ||
      !recorderProfile ||
      store.isCancelled ||
      audioRecordingDisabled
    )
      return;
    const transcriptId = recordingTranscriptId;
    const partIndex = mediaParts.length;
    const recorder = new MediaRecorder(stream, {
      mimeType: recorderProfile.mimeType,
      audioBitsPerSecond: 64_000,
    });
    const mimeType = recorder.mimeType || recorderProfile.mimeType;
    const part = {
      index: partIndex,
      start: currentActiveSeconds(),
      mimeType,
      sizeBytes: 0,
      fragmentCount: 0,
    };
    currentPart = part;
    recorder.addEventListener("dataavailable", (event) => {
      if (audioRecordingDisabled || !event.data?.size) return;
      if (pendingFragmentWrites >= MAX_PENDING_FRAGMENT_WRITES) {
        void disableAudioPersistence(
          new Error(
            "Browser storage is too slow to keep recording audio safely",
          ),
          transcriptId,
        );
        return;
      }
      const fragmentIndex = part.fragmentCount;
      part.fragmentCount += 1;
      part.sizeBytes += event.data.size;
      pendingFragmentWrites += 1;
      fragmentWriteQueue = fragmentWriteQueue
        .then(async () => {
          await audioAssets.assertStorageHeadroom(event.data.size);
          await audioAssets.stageFragment({
            transcriptId,
            partIndex,
            fragmentIndex,
            blob: event.data,
          });
        })
        .catch((error) => disableAudioPersistence(error, transcriptId))
        .finally(() => {
          if (recordingTranscriptId === transcriptId)
            pendingFragmentWrites -= 1;
        });
    });
    mediaRecorder = recorder;
    recorder.start(MEDIA_RECORDER_TIMESLICE_MS);
  }

  async function disableAudioPersistence(
    error,
    transcriptId = recordingTranscriptId,
  ) {
    if (!transcriptId) return;
    if (recordingTranscriptId !== transcriptId) {
      await audioAssets.rollbackStaging(transcriptId);
      return;
    }
    if (audioRecordingDisabled) return;
    audioRecordingDisabled = true;
    audioPersistenceError.value =
      error instanceof Error
        ? error
        : new Error("Could not save recording audio");
    stopRecorderImmediately();
    await audioAssets.rollbackStaging(transcriptId);
  }

  async function finishMediaPart(endTime) {
    const recorder = mediaRecorder;
    const part = currentPart;
    if (!recorder || !part) return;
    mediaRecorder = null;
    currentPart = null;
    if (recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    }
    await fragmentWriteQueue;
    if (part.fragmentCount > 0 && part.sizeBytes > 0) {
      mediaParts.push({
        ...part,
        end: Math.max(part.start + 0.001, endTime),
      });
    }
  }

  function stopRecorderImmediately() {
    if (mediaRecorder?.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {
        // Track shutdown may already have stopped the recorder.
      }
    }
    mediaRecorder = null;
    currentPart = null;
  }

  function currentActiveSeconds() {
    if (!sessionStartTime) return 0;
    const end = pausedAt || Date.now();
    return Math.max(0, (end - sessionStartTime - totalPausedMs) / 1000);
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

  /** @param {string} transcriptId */
  async function finishAudioStaging(transcriptId) {
    await audioAssets.finishStaging(transcriptId);
  }

  /** @param {string} transcriptId */
  async function rollbackAudioStaging(transcriptId) {
    await audioAssets.rollbackStaging(transcriptId);
  }

  return {
    start,
    pause,
    resume,
    stop,
    cancel,
    finishAudioStaging,
    rollbackAudioStaging,
    switchInput,
    retryInput,
    audioManifest,
    audioPersistenceError,
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
