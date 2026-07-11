import { useModelManager } from "./useModelManager.js";
import { useAudioPreparation } from "./useAudioPreparation.js";
import { useVoiceActivityDetection } from "./useVoiceActivityDetection.js";
import { useAsrInference } from "./useAsrInference.js";
import { useDiarization } from "./useDiarization.js";
import { trackAnalyticsEvent } from "@/lib/eventSignals.js";

/**
 * Top-level orchestrator. Sequences the full transcription pipeline:
 *   1. Check/download models
 *   2. Transcode audio to 16kHz mono PCM
 *   3. Run VAD to find speech regions
 *   4. Run ASR inference on each chunk
 *
 * Diarization runs as a lightweight local speaker-assignment pass.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useTranscriptionPipeline(store) {
  const modelManager = useModelManager(store);
  const audioPrep = useAudioPreparation(store);
  const vad = useVoiceActivityDetection(store);
  const asr = useAsrInference(store);
  const diarization = useDiarization(store);

  /**
   * Run the full pipeline from file → transcript segments.
   */
  async function start() {
    if (!store.file) return;

    const startTime = Date.now();
    store.clearProcessingState();
    store.segments = [];
    store.speakerNames = {};
    store.speakerColors = {};
    store.error = null;

    const runtime = store.effectiveRuntime;

    trackAnalyticsEvent("transcription_started", {
      runtime,
      diarizationEnabled: store.enableDiarization,
      fileSizeMb: Math.round((store.fileSize / (1024 * 1024)) * 10) / 10,
      estimatedDurationSec: store.fileDuration
        ? Math.round(store.fileDuration)
        : null,
    });

    try {
      let pcm = null;

      // 1. Prepare model cache/runtime. The ASR worker will switch this
      // to download or local-cache loading once it knows the asset source.
      store.processPhase = "checking-cache";
      await modelManager.checkCache();
      await asr.initialize(runtime);

      if (store.isCancelled) throw abort();

      // Pre-download the diarization model alongside ASR models so the
      // diarization worker finds it cached and doesn't stall at stage 5.
      if (store.enableDiarization) {
        await modelManager.ensureDiarizationModel();
      }

      if (store.isCancelled) throw abort();

      // 2. Transcode audio
      store.processPhase = "transcoding";
      pcm = await audioPrep.prepare(store.file);
      store.fileDuration = pcm.length / 16000;

      if (store.isCancelled) throw abort();

      // 3. Voice activity detection
      store.processPhase = "vad";
      const speechRegions = await vad.detect(pcm);
      if (!speechRegions.length) {
        throw new Error("NO_SPEECH_DETECTED");
      }

      if (store.isCancelled) throw abort();

      // 4. ASR inference (worker already initialized).
      store.processPhase = "transcribing";
      store.updateProgress("transcription", 0);
      const segments = await asr.transcribeChunks(pcm, speechRegions);
      if (!segments.length) {
        throw new Error("ASR_EMPTY_RESULT");
      }
      store.setSegments(segments);

      if (store.enableDiarization) {
        if (store.isCancelled) throw abort();

        store.processPhase = "diarizing";
        const diarizedSegments = await diarization.diarize(pcm, segments);
        store.setSegments(diarizedSegments);
      }

      store.processPhase = "complete";

      trackAnalyticsEvent("transcription_completed", {
        runtime,
        diarizationEnabled: store.enableDiarization,
        durationMs: Date.now() - startTime,
        segmentCount: segments.length,
      });
    } catch (err) {
      // Make sure the ASR worker (initialized before transcoding now) is
      // torn down on any failure path.
      asr.abort();

      if (err?.name === "AbortError" || store.isCancelled) {
        store.clearProcessingState();
        trackAnalyticsEvent("transcription_cancelled", {
          phase: store.processPhase,
        });
        return;
      }

      console.error("Transcription pipeline error:", err);
      store.processPhase = "error";
      store.error = classifyError(err);

      trackAnalyticsEvent("transcription_failed", {
        phase: store.processPhase,
        errorCode: store.error.code,
      });
    }
  }

  function abort() {
    modelManager.abort();
    audioPrep.abort();
    vad.abort();
    asr.abort();
    diarization.abort();
    return new DOMException("Aborted", "AbortError");
  }

  function cancel() {
    store.isCancelled = true;
    abort();
    store.clearProcessingState();
  }

  /**
   * Reprocess raw 16kHz mono PCM through the full pipeline (VAD → ASR → diarization),
   * skipping the transcode step. Used after a live session to get better segmentation
   * and speaker identification.
   *
   * @param {Float32Array} pcm - 16kHz mono Float32 PCM audio
   * @param {{ enableDiarization?: boolean }} [options]
   */
  async function reprocessFromPcm(pcm, options = {}) {
    const enableDiarization = options.enableDiarization ?? true;
    const startTime = Date.now();

    store.clearProcessingState();
    store.segments = [];
    store.speakerNames = {};
    store.speakerColors = {};
    store.error = null;
    store.fileDuration = pcm.length / 16000;

    const runtime = store.effectiveRuntime;

    trackAnalyticsEvent("transcription_reprocess_started", {
      runtime,
      diarizationEnabled: enableDiarization,
      durationSec: Math.round(pcm.length / 16000),
    });

    try {
      // 1. Check/download models
      store.processPhase = "checking-cache";
      await modelManager.checkCache();
      await asr.initialize(runtime);

      if (store.isCancelled) throw abort();

      if (enableDiarization) {
        await modelManager.ensureDiarizationModel();
      }

      if (store.isCancelled) throw abort();

      // 2. VAD (skip transcoding — PCM is already 16kHz mono)
      store.processPhase = "vad";
      const speechRegions = await vad.detect(pcm);
      if (!speechRegions.length) {
        throw new Error("NO_SPEECH_DETECTED");
      }

      if (store.isCancelled) throw abort();

      // 3. ASR inference
      store.processPhase = "transcribing";
      store.updateProgress("transcription", 0);
      const segments = await asr.transcribeChunks(pcm, speechRegions);
      if (!segments.length) {
        throw new Error("ASR_EMPTY_RESULT");
      }
      store.setSegments(segments);

      // 4. Diarization
      if (enableDiarization) {
        if (store.isCancelled) throw abort();

        store.processPhase = "diarizing";
        const diarizedSegments = await diarization.diarize(pcm, segments);
        store.setSegments(diarizedSegments);
      }

      store.processPhase = "complete";

      trackAnalyticsEvent("transcription_reprocess_completed", {
        runtime,
        diarizationEnabled: enableDiarization,
        durationMs: Date.now() - startTime,
        segmentCount: store.segments.length,
      });
    } catch (err) {
      asr.abort();

      if (err?.name === "AbortError" || store.isCancelled) {
        store.clearProcessingState();
        trackAnalyticsEvent("transcription_reprocess_cancelled", {
          phase: store.processPhase,
        });
        return;
      }

      console.error("Reprocess pipeline error:", err);
      store.processPhase = "error";
      store.error = classifyError(err);

      trackAnalyticsEvent("transcription_reprocess_failed", {
        phase: store.processPhase,
        errorCode: store.error.code,
      });
    }
  }

  return { start, cancel, reprocessFromPcm };
}

/**
 * Classify an error into a user-friendly structure.
 * @param {Error} err
 * @returns {{ code: string, message: string, recoverable: boolean }}
 */
function classifyError(err) {
  const msg = err.message || String(err);

  if (msg.includes("FFMPEG") || msg.includes("FFmpeg")) {
    return {
      code: "TRANSCODE_FAILED",
      message: "Failed to prepare audio. The file format may not be supported.",
      recoverable: true,
    };
  }
  if (msg.includes("VAD")) {
    return {
      code: "VAD_FAILED",
      message: "Speech detection failed. Try a different file.",
      recoverable: true,
    };
  }
  if (msg.includes("DIARIZATION") || msg.includes("Diarization")) {
    return {
      code: "DIARIZATION_FAILED",
      message:
        "Speaker labeling failed. Try again with speaker diarization turned off.",
      recoverable: true,
    };
  }
  if (msg.includes("ASR") || msg.includes("onnx") || msg.includes("ONNX")) {
    return {
      code: "ASR_FAILED",
      message: msg.includes("ASR_EMPTY_RESULT")
        ? "The transcription model finished but did not produce readable text. Try switching runtime in settings or using a clearer audio sample."
        : "Transcription model failed. Try switching the runtime in settings.",
      recoverable: true,
    };
  }
  if (msg.includes("NO_SPEECH_DETECTED")) {
    return {
      code: "NO_SPEECH_DETECTED",
      message:
        "No speech was detected in this file. Try a file with clearer spoken audio.",
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
  if (
    msg.includes("memory") ||
    msg.includes("OOM") ||
    msg.includes("allocation")
  ) {
    return {
      code: "OUT_OF_MEMORY",
      message:
        "Ran out of memory. Try a shorter audio file or close other tabs.",
      recoverable: false,
    };
  }

  return {
    code: "UNKNOWN",
    message: msg || "An unexpected error occurred.",
    recoverable: true,
  };
}
