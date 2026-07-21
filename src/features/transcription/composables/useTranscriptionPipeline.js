import { useModelManager } from "./useModelManager.js";
import { useAudioPreparation } from "./useAudioPreparation.js";
import { useVoiceActivityDetection } from "./useVoiceActivityDetection.js";
import { useAsrInference } from "./useAsrInference.js";
import { useDiarization } from "./useDiarization.js";
import { trackAnalyticsEvent } from "@/lib/eventSignals.js";
import {
  createAudioWindows,
  getCommittedPcmView,
} from "@/features/transcription/lib/audioWindowing.js";
import { createWaveformAccumulator } from "@/features/transcription/lib/waveformAccumulator.js";
import { ref } from "vue";
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";
import { normalizeTranscriptAudioManifest } from "@/features/transcription/lib/transcriptAudioManifest.js";
import {
  canUseStreamingWebmEncoder,
  useStreamingWebmEncoder,
} from "./useStreamingWebmEncoder.js";

const ENABLE_TRANSCRIPTION_DIAGNOSTICS = import.meta.env.DEV;

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
  const audioPrep = useAudioPreparation();
  const vad = useVoiceActivityDetection();
  const asr = useAsrInference(store);
  const diarization = useDiarization(store);
  const audioAssets = useTranscriptionAudioAssets();
  const audioManifest = ref(
    /** @type {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest | null} */ (
      null
    ),
  );
  const audioPersistenceError = ref(/** @type {Error | null} */ (null));
  /** @type {Promise<Float32Array | { pcm: Float32Array, proxyBlob: Blob | null, proxyError?: Error }> | null} */
  let activePreparation = null;

  function prepare(window) {
    const startedAt = monotonicNow();
    activePreparation = audioPrep.prepareWindow(window).then((pcm) => {
      logWindowDiagnostics("preparation", window, startedAt, {
        pcmBytes: pcm.byteLength,
        durationSec: window.readEnd - window.readStart,
      });
      return pcm;
    });
    return activePreparation;
  }

  function prepareCommittedWindow(window) {
    return prepare({ ...window, readStart: window.commitStart });
  }

  function prepareUploadWindow(window) {
    const startedAt = monotonicNow();
    activePreparation = audioPrep
      .prepareWindowWithProxy(window)
      .then((result) => {
        logWindowDiagnostics("preparation-and-proxy", window, startedAt, {
          pcmBytes: result.pcm.byteLength,
          proxyBytes: result.proxyBlob.size,
        });
        return result;
      })
      .catch(async (error) => ({
        pcm: await audioPrep.prepareWindow(window),
        proxyBlob: null,
        proxyError:
          error instanceof Error
            ? error
            : new Error("Audio proxy encoding failed"),
      }));
    return activePreparation;
  }

  async function consumePreparation(preparation) {
    try {
      return await preparation;
    } finally {
      if (activePreparation === preparation) activePreparation = null;
    }
  }

  /**
   * Run the full pipeline from file → transcript segments.
   */
  async function start(options = {}) {
    if (!store.file) return;
    const transcriptId = options.transcriptId || null;
    audioManifest.value = null;
    audioPersistenceError.value = null;
    let shouldPersistAudio = Boolean(transcriptId);
    let audioPersistenceMode = transcriptId ? "multipart" : "none";
    let continuousAudioSession = null;
    let continuousAudioManifest = null;
    /** @type {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioPart[]} */
    const proxyParts = [];

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

    let audioSessionOpen = false;
    try {
      if (transcriptId) await audioAssets.beginStaging(transcriptId);
      // 1. Prepare the ASR model and file-backed FFmpeg session together so
      // sustainable preparation does not add serial startup latency.
      store.processPhase = "checking-cache";
      await modelManager.checkCache();
      const audioSessionPromise = audioPrep
        .open(store.file, store.fileDuration)
        .then((session) => {
          audioSessionOpen = true;
          return session;
        });
      const [audioSession] = await Promise.all([
        audioSessionPromise,
        asr.initialize(runtime),
      ]);
      const duration = audioSession.duration;
      store.fileDuration = duration;
      const windows = createAudioWindows(duration);
      const waveform = createWaveformAccumulator({ duration });
      if (transcriptId && (await canUseStreamingWebmEncoder())) {
        continuousAudioSession = useStreamingWebmEncoder({
          transcriptId,
          audioAssets,
        });
        try {
          await continuousAudioSession.start();
          audioPersistenceMode = "continuous";
        } catch {
          // A browser can advertise Opus support yet fail to initialize an
          // encoder. Start a fresh lease and retain the existing safe fallback.
          continuousAudioSession = null;
          await audioAssets.rollbackStaging(transcriptId);
          await audioAssets.beginStaging(transcriptId);
        }
      }

      if (store.isCancelled) throw abort();

      // Pre-download the diarization model alongside ASR models so the
      // diarization worker finds it cached and doesn't stall at stage 5.
      if (store.enableDiarization) {
        await modelManager.ensureDiarizationModel();
      }

      if (store.isCancelled) throw abort();

      // 2. Prepare, detect, and transcribe bounded windows. Start N+1 only
      // after receiving N, then consume N while the one look-ahead decodes.
      store.updateProgress("transcription", 0);
      store.processPhase = "transcoding";
      let preparation =
        audioPersistenceMode === "multipart"
          ? prepareUploadWindow(windows[0])
          : prepare(windows[0]);
      let transcriptRows = [];

      for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index];
        const prepared = await consumePreparation(preparation);
        let pcm =
          prepared instanceof Float32Array
            ? prepared
            : /** @type {{ pcm: Float32Array }} */ (prepared).pcm;
        if (store.isCancelled) throw abort();
        if (
          transcriptId &&
          shouldPersistAudio &&
          audioPersistenceMode === "continuous"
        ) {
          try {
            await continuousAudioSession.appendPcm(
              getCommittedPcmView(pcm, window),
              {
                timestampSeconds: window.commitStart,
              },
            );
          } catch (error) {
            shouldPersistAudio = false;
            audioPersistenceMode = "none";
            audioPersistenceError.value =
              error instanceof Error
                ? error
                : new Error("Could not save transcript audio");
            await continuousAudioSession.cancel().catch(() => {});
            await audioAssets.rollbackStaging(transcriptId);
            continuousAudioSession = null;
          }
        } else if (
          transcriptId &&
          shouldPersistAudio &&
          audioPersistenceMode === "multipart"
        ) {
          try {
            if (prepared.proxyError || !prepared.proxyBlob) {
              throw (
                prepared.proxyError || new Error("Audio proxy encoding failed")
              );
            }
            await audioAssets.assertStorageHeadroom(prepared.proxyBlob.size);
            await audioAssets.stageFragment({
              transcriptId,
              partIndex: window.index,
              fragmentIndex: 0,
              blob: prepared.proxyBlob,
            });
            proxyParts.push({
              index: window.index,
              start: window.commitStart,
              end: window.commitEnd,
              mimeType: prepared.proxyBlob.type || "audio/webm;codecs=opus",
              sizeBytes: prepared.proxyBlob.size,
              fragmentCount: 1,
            });
          } catch (error) {
            shouldPersistAudio = false;
            audioPersistenceMode = "none";
            audioPersistenceError.value =
              error instanceof Error
                ? error
                : new Error("Could not save transcript audio");
            await audioAssets.rollbackStaging(transcriptId);
          }
        }
        preparation = windows[index + 1]
          ? audioPersistenceMode === "multipart"
            ? prepareUploadWindow(windows[index + 1])
            : prepare(windows[index + 1])
          : null;

        waveform.addWindow(pcm, window);
        store.waveformSamples = waveform.finalize();

        store.processPhase = "vad";
        const vadStartedAt = monotonicNow();
        const detected = await vad.detectWindow(pcm);
        logWindowDiagnostics("vad", window, vadStartedAt, {
          speechRegionCount: detected.regions.length,
        });
        pcm = detected.pcm;
        if (store.isCancelled) throw abort();
        if (!detected.regions.length) continue;

        store.processPhase = "transcribing";
        const asrStartedAt = monotonicNow();
        const windowRows = await asr.transcribeWindow(pcm, detected.regions, {
          offset: window.readStart,
          windowIndex: window.index,
          totalWindows: window.total,
        });
        logWindowDiagnostics("asr", window, asrStartedAt, {
          segmentCount: windowRows.length,
        });
        transcriptRows = asr.mergeSegments([...transcriptRows, ...windowRows]);
        store.setSegments(transcriptRows);
      }

      if (!transcriptRows.length) {
        throw new Error("ASR_EMPTY_RESULT");
      }
      if (
        transcriptId &&
        shouldPersistAudio &&
        audioPersistenceMode === "continuous"
      ) {
        try {
          continuousAudioManifest = await continuousAudioSession.finalize();
          continuousAudioSession = null;
        } catch (error) {
          shouldPersistAudio = false;
          audioPersistenceMode = "none";
          audioPersistenceError.value =
            error instanceof Error
              ? error
              : new Error("Could not save transcript audio");
          await audioAssets.rollbackStaging(transcriptId);
          continuousAudioSession = null;
        }
      }
      asr.cleanup();

      if (store.enableDiarization) {
        if (store.isCancelled) throw abort();

        store.processPhase = "diarizing";
        await diarization.initialize(runtime);
        // Diarization carries sequential speaker state, so unlike ASR it
        // consumes only committed ranges and never repeats boundary overlap.
        let diarizationPreparation = prepareCommittedWindow(windows[0]);
        for (let index = 0; index < windows.length; index += 1) {
          const pcm = await consumePreparation(diarizationPreparation);
          diarizationPreparation = windows[index + 1]
            ? prepareCommittedWindow(windows[index + 1])
            : null;
          if (store.isCancelled) throw abort();
          const diarizationStartedAt = monotonicNow();
          await diarization.processWindow(pcm, {
            windowIndex: index,
            totalWindows: windows.length,
          });
          logWindowDiagnostics(
            "diarization",
            windows[index],
            diarizationStartedAt,
            {
              pcmBytes: pcm.byteLength,
            },
          );
        }
        transcriptRows = await diarization.finalize(transcriptRows);
      } else {
        transcriptRows = await asr.finalizeSegments(transcriptRows, {
          skipDiarize: true,
        });
      }
      store.setSegments(transcriptRows);
      if (transcriptId && shouldPersistAudio) {
        audioManifest.value =
          continuousAudioManifest ??
          normalizeTranscriptAudioManifest({
            version: 1,
            duration,
            source: "upload",
            parts: proxyParts,
          });
      }

      store.processPhase = "complete";

      trackAnalyticsEvent("transcription_completed", {
        runtime,
        diarizationEnabled: store.enableDiarization,
        durationMs: Date.now() - startTime,
        segmentCount: transcriptRows.length,
      });
    } catch (err) {
      // Tear down every active worker and suppress a rejected look-ahead.
      abort();
      if (continuousAudioSession) {
        await continuousAudioSession.cancel().catch(() => {});
        continuousAudioSession = null;
      }

      if (transcriptId) await audioAssets.rollbackStaging(transcriptId);
      audioManifest.value = null;
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
    } finally {
      activePreparation = null;
      if (audioSessionOpen) {
        try {
          await audioPrep.close();
        } catch (error) {
          console.warn("Failed to close transcription audio session:", error);
        }
      }
    }
  }

  /** @param {string} transcriptId */
  async function finishAudioStaging(transcriptId) {
    await audioAssets.finishStaging(transcriptId);
  }

  /** @param {string} transcriptId */
  async function rollbackAudioStaging(transcriptId) {
    await audioAssets.rollbackStaging(transcriptId);
  }

  function abort() {
    activePreparation?.catch(() => {});
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
   * Reprocess persisted compressed media parts without concatenating the full
   * recording or retaining full-session PCM. Each logical part is mounted and
   * decoded through the existing bounded window contract.
   * @param {string} transcriptId
   * @param {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest} manifestValue
   * @param {{ enableDiarization?: boolean }} [options]
   */
  async function reprocessFromManifest(
    transcriptId,
    manifestValue,
    options = {},
  ) {
    const manifest = normalizeTranscriptAudioManifest(manifestValue);
    const enableDiarization = options.enableDiarization ?? true;
    const runtime = store.effectiveRuntime;
    const startTime = Date.now();
    store.clearProcessingState();
    store.segments = [];
    store.speakerNames = {};
    store.speakerColors = {};
    store.error = null;
    store.fileDuration = manifest.duration;

    try {
      store.processPhase = "checking-cache";
      await modelManager.checkCache();
      await asr.initialize(runtime);
      if (enableDiarization) await modelManager.ensureDiarizationModel();
      if (store.isCancelled) throw abort();

      let transcriptRows = [];
      let globalWindowIndex = 0;
      const totalWindows = manifest.parts.reduce(
        (total, part) =>
          total + createAudioWindows(part.end - part.start).length,
        0,
      );

      for (const part of manifest.parts) {
        const blob = await audioAssets.getPartBlob(transcriptId, part);
        const file = new File([blob], `transcript-part-${part.index}`, {
          type: part.mimeType,
        });
        await audioPrep.open(file, part.end - part.start);
        try {
          const windows = createAudioWindows(part.end - part.start);
          let preparation = prepare(windows[0]);
          for (let index = 0; index < windows.length; index += 1) {
            const window = windows[index];
            let pcm = /** @type {Float32Array} */ (
              await consumePreparation(preparation)
            );
            preparation = windows[index + 1]
              ? prepare(windows[index + 1])
              : null;
            const detected = await vad.detectWindow(pcm);
            pcm = detected.pcm;
            if (detected.regions.length) {
              const rows = await asr.transcribeWindow(pcm, detected.regions, {
                offset: part.start + window.readStart,
                windowIndex: globalWindowIndex,
                totalWindows,
              });
              transcriptRows = asr.mergeSegments([...transcriptRows, ...rows]);
              store.setSegments(transcriptRows);
            }
            globalWindowIndex += 1;
          }
        } finally {
          await audioPrep.close();
        }
      }

      if (!transcriptRows.length) throw new Error("ASR_EMPTY_RESULT");
      asr.cleanup();

      if (enableDiarization) {
        store.processPhase = "diarizing";
        await diarization.initialize(runtime);
        let diarizationIndex = 0;
        for (const part of manifest.parts) {
          const blob = await audioAssets.getPartBlob(transcriptId, part);
          const file = new File([blob], `transcript-part-${part.index}`, {
            type: part.mimeType,
          });
          await audioPrep.open(file, part.end - part.start);
          try {
            const windows = createAudioWindows(part.end - part.start);
            let preparation = prepareCommittedWindow(windows[0]);
            for (let index = 0; index < windows.length; index += 1) {
              const pcm = /** @type {Float32Array} */ (
                await consumePreparation(preparation)
              );
              preparation = windows[index + 1]
                ? prepareCommittedWindow(windows[index + 1])
                : null;
              await diarization.processWindow(pcm, {
                windowIndex: diarizationIndex,
                totalWindows,
              });
              diarizationIndex += 1;
            }
          } finally {
            await audioPrep.close();
          }
        }
        transcriptRows = await diarization.finalize(transcriptRows);
      } else {
        transcriptRows = await asr.finalizeSegments(transcriptRows, {
          skipDiarize: true,
        });
      }

      store.setSegments(transcriptRows);
      store.processPhase = "complete";
      trackAnalyticsEvent("transcription_reprocess_completed", {
        runtime,
        diarizationEnabled: enableDiarization,
        durationMs: Date.now() - startTime,
        segmentCount: transcriptRows.length,
      });
    } catch (err) {
      abort();
      if (err?.name === "AbortError" || store.isCancelled) {
        store.clearProcessingState();
        return;
      }
      console.error("Manifest reprocess pipeline error:", err);
      store.processPhase = "error";
      store.error = classifyError(err);
    }
  }

  return {
    start,
    cancel,
    reprocessFromManifest,
    finishAudioStaging,
    rollbackAudioStaging,
    audioManifest,
    audioPersistenceError,
  };
}

function monotonicNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function logWindowDiagnostics(phase, window, startedAt, metrics = {}) {
  if (!ENABLE_TRANSCRIPTION_DIAGNOSTICS || typeof console === "undefined")
    return;
  console.info("[transcription][window]", {
    phase,
    windowIndex: window.index,
    totalWindows: window.total,
    elapsedMs: Math.round((monotonicNow() - startedAt) * 10) / 10,
    ...metrics,
  });
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
