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
import { selectTranscriptionEngines } from "@/features/transcription/lib/engineSelection.js";
import { planQwenRegions } from "@/features/transcription/lib/qwenAsrRegions.js";
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
 * Diarization normally runs after ASR and assigns speakers to timestamped
 * words. Qwen3-ASR has no word timestamps, so for Chinese with speaker
 * identification the diarization pass runs first and ASR transcribes regions
 * cut at speaker turns.
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

  /**
   * Engines for this run; reprocessing may override speaker identification.
   * @param {boolean} enableDiarization
   */
  function selectEngines(enableDiarization) {
    return selectTranscriptionEngines({
      language: store.language ?? "en",
      speakerMode: enableDiarization ? "group" : "solo",
      runtime: store.effectiveRuntime,
      shaderF16: Boolean(store.shaderF16),
      speakerModel: store.speakerModel ?? "nemotron",
    });
  }

  /**
   * Run the diarizer over committed ranges. Unlike ASR it carries sequential
   * speaker state, so it never repeats boundary overlap.
   * @param {Array<{ windows: ReturnType<typeof createAudioWindows>, open?: () => Promise<void>, close?: () => Promise<void> }>} sources
   * @param {number} totalWindows
   */
  async function diarizeCommittedWindows(sources, totalWindows) {
    let diarizationIndex = 0;
    for (const source of sources) {
      await source.open?.();
      try {
        const { windows } = source;
        let preparation = prepareCommittedWindow(windows[0]);
        for (let index = 0; index < windows.length; index += 1) {
          const pcm = /** @type {Float32Array} */ (
            await consumePreparation(preparation)
          );
          preparation = windows[index + 1]
            ? prepareCommittedWindow(windows[index + 1])
            : null;
          if (store.isCancelled) throw abort();
          const startedAt = monotonicNow();
          await diarization.processWindow(pcm, {
            windowIndex: diarizationIndex,
            totalWindows,
          });
          logWindowDiagnostics("diarization", windows[index], startedAt, {
            pcmBytes: pcm.byteLength,
          });
          diarizationIndex += 1;
        }
      } finally {
        await source.close?.();
      }
    }
  }

  /**
   * Transcribe one window with Qwen3-ASR over planned regions.
   * @param {Float32Array} pcm
   * @param {Array<{ start: number, end: number }>} regions
   * @param {{ readStart: number, commitStart: number, commitEnd: number }} window
   * @param {number} baseOffset absolute start of the source (manifest part)
   * @param {Array<{ id: number, start: number, end: number }> | null} turns
   * @param {{ windowIndex: number, totalWindows: number }} progress
   */
  async function transcribeQwenWindow(
    pcm,
    regions,
    window,
    baseOffset,
    turns,
    progress,
  ) {
    const planned = planQwenRegions({
      pcm,
      regions,
      offset: baseOffset + window.readStart,
      commitStart: baseOffset + window.commitStart,
      commitEnd: baseOffset + window.commitEnd,
      turns,
    });
    if (!planned.length) return [];
    return await asr.transcribeRegions(pcm, planned, {
      offset: baseOffset + window.readStart,
      ...progress,
    });
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
    const selection = selectEngines(store.enableDiarization);
    const usesQwen = selection.asr.engine === "qwen3-asr";

    trackAnalyticsEvent("transcription_started", {
      runtime,
      asrEngine: selection.asr.engine,
      diarizationEngine: selection.diarization?.engine ?? null,
      diarizationEnabled: Boolean(selection.diarization),
      fileSizeMb: Math.round((store.fileSize / (1024 * 1024)) * 10) / 10,
      estimatedDurationSec: store.fileDuration
        ? Math.round(store.fileDuration)
        : null,
    });

    let audioSessionOpen = false;
    try {
      if (!selection.available) {
        throw new Error(`ENGINE_UNAVAILABLE: ${selection.unavailableReason}`);
      }
      if (transcriptId) await audioAssets.beginStaging(transcriptId);
      // 1. Prepare the ASR model and file-backed FFmpeg session together so
      // sustainable preparation does not add serial startup latency.
      store.processPhase = "checking-cache";
      await modelManager.checkCache(selection.assetKeys);
      const audioSessionPromise = audioPrep
        .open(store.file, store.fileDuration)
        .then((session) => {
          audioSessionOpen = true;
          return session;
        });
      // Diarize-first runs load the diarizer before ASR so the two large
      // models are never resident together.
      const [audioSession] = await Promise.all([
        audioSessionPromise,
        selection.diarizeFirst
          ? Promise.resolve()
          : asr.initialize(runtime, selection.asr),
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
      if (selection.diarization) {
        await modelManager.ensureDiarizationModel(selection.assetKeys);
      }

      if (store.isCancelled) throw abort();

      /** @type {Array<{ id: number, start: number, end: number }> | null} */
      let speakerTurns = null;
      if (selection.diarizeFirst && selection.diarization) {
        store.processPhase = "diarizing";
        await diarization.initialize(runtime, selection.diarization);
        await diarizeCommittedWindows([{ windows }], windows.length);
        speakerTurns = await diarization.finalizeTurns();
        if (store.isCancelled) throw abort();
        store.processPhase = "loading-model";
        await asr.initialize(runtime, selection.asr);
      }

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
        const windowRows = usesQwen
          ? await transcribeQwenWindow(
              pcm,
              detected.regions,
              window,
              0,
              speakerTurns,
              { windowIndex: window.index, totalWindows: window.total },
            )
          : await asr.transcribeWindow(pcm, detected.regions, {
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

      if (selection.diarization && !selection.diarizeFirst) {
        if (store.isCancelled) throw abort();

        store.processPhase = "diarizing";
        await diarization.initialize(runtime, selection.diarization);
        await diarizeCommittedWindows([{ windows }], windows.length);
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
        asrEngine: selection.asr.engine,
        diarizationEnabled: Boolean(selection.diarization),
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
    const selection = selectEngines(enableDiarization);
    const usesQwen = selection.asr.engine === "qwen3-asr";
    const startTime = Date.now();
    store.clearProcessingState();
    store.segments = [];
    store.speakerNames = {};
    store.speakerColors = {};
    store.error = null;
    store.fileDuration = manifest.duration;

    try {
      if (!selection.available) {
        throw new Error(`ENGINE_UNAVAILABLE: ${selection.unavailableReason}`);
      }
      store.processPhase = "checking-cache";
      await modelManager.checkCache(selection.assetKeys);
      if (!selection.diarizeFirst) await asr.initialize(runtime, selection.asr);
      if (selection.diarization) {
        await modelManager.ensureDiarizationModel(selection.assetKeys);
      }
      if (store.isCancelled) throw abort();

      let transcriptRows = [];
      let globalWindowIndex = 0;
      const totalWindows = manifest.parts.reduce(
        (total, part) =>
          total + createAudioWindows(part.end - part.start).length,
        0,
      );
      const diarizationSources = manifest.parts.map((part) => ({
        windows: createAudioWindows(part.end - part.start),
        open: async () => {
          const blob = await audioAssets.getPartBlob(transcriptId, part);
          const file = new File([blob], `transcript-part-${part.index}`, {
            type: part.mimeType,
          });
          await audioPrep.open(file, part.end - part.start);
        },
        close: () => audioPrep.close(),
      }));

      /** @type {Array<{ id: number, start: number, end: number }> | null} */
      let speakerTurns = null;
      if (selection.diarizeFirst && selection.diarization) {
        store.processPhase = "diarizing";
        await diarization.initialize(runtime, selection.diarization);
        await diarizeCommittedWindows(diarizationSources, totalWindows);
        speakerTurns = await diarization.finalizeTurns();
        store.processPhase = "loading-model";
        await asr.initialize(runtime, selection.asr);
      }

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
              const rows = usesQwen
                ? await transcribeQwenWindow(
                    pcm,
                    detected.regions,
                    window,
                    part.start,
                    speakerTurns,
                    { windowIndex: globalWindowIndex, totalWindows },
                  )
                : await asr.transcribeWindow(pcm, detected.regions, {
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

      if (selection.diarization && !selection.diarizeFirst) {
        store.processPhase = "diarizing";
        await diarization.initialize(runtime, selection.diarization);
        await diarizeCommittedWindows(diarizationSources, totalWindows);
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

  if (msg.startsWith("ENGINE_UNAVAILABLE")) {
    return {
      code: "ENGINE_UNAVAILABLE",
      message: msg.replace(/^ENGINE_UNAVAILABLE:\s*/, ""),
      recoverable: true,
    };
  }
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
