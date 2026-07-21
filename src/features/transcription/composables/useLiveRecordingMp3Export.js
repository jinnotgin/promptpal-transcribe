import { ref } from "vue";
import { createAudioWindows } from "@/features/transcription/lib/audioWindowing.js";
import { normalizeTranscriptAudioManifest } from "@/features/transcription/lib/transcriptAudioManifest.js";
import { useAudioPreparation } from "./useAudioPreparation.js";
import { useStreamingMp3Encoder } from "./useStreamingMp3Encoder.js";
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";

/**
 * Decode persisted browser-native media in bounded windows and stream the PCM
 * into temporary position-aware MP3 pages. Transcript persistence remains in
 * its original browser-native format.
 *
 * @param {{
 *   audioAssets?: Pick<ReturnType<useTranscriptionAudioAssets>, 'getPartBlob' | 'rollbackStaging'>,
 *   audioPreparation?: Pick<ReturnType<useAudioPreparation>, 'open' | 'prepareWindow' | 'close' | 'abort'>,
 *   streamingEncoderFactory?: (options: any) => Pick<ReturnType<typeof useStreamingMp3Encoder>, 'start' | 'appendPcm' | 'finalize' | 'cancel'>,
 *   createId?: () => string,
 * }} [options]
 */
export function useLiveRecordingMp3Export(options = {}) {
  const isConverting = ref(false);
  const progress = ref(0);
  const audioAssets = options.audioAssets ?? useTranscriptionAudioAssets();
  const audioPreparation = options.audioPreparation ?? useAudioPreparation();
  const streamingEncoderFactory =
    options.streamingEncoderFactory ?? useStreamingMp3Encoder;
  const createId = options.createId ?? createTemporaryExportId;
  let activeSession = null;
  let activeTemporaryId = null;
  let cancelRequested = false;

  /**
   * @param {{
   *   transcriptId?: string | null,
   *   manifest?: import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest | null,
   * }} input
   */
  async function convert(input) {
    if (isConverting.value)
      throw new Error("An MP3 conversion is already in progress");
    const sources = normalizeSources(input);
    isConverting.value = true;
    try {
      await release();
      progress.value = 0;
      cancelRequested = false;
      activeTemporaryId = createId();
      activeSession = streamingEncoderFactory({
        transcriptId: activeTemporaryId,
        source: "live",
        audioAssets,
      });
      let totalWindows = 0;
      for (const source of sources)
        totalWindows += createAudioWindows(source.duration).length;
      let completedWindows = 0;
      await activeSession.start();
      progress.value = 2;
      for (const source of sources) {
        if (cancelRequested)
          throw new DOMException("MP3 conversion cancelled", "AbortError");
        const blob =
          source.blob ??
          (await audioAssets.getPartBlob(input.transcriptId, source.part));
        const file = new File([blob], `live-recording-part-${source.index}`, {
          type: source.mimeType,
        });
        await audioPreparation.open(file, source.duration);
        try {
          for (const window of createAudioWindows(source.duration)) {
            if (cancelRequested) {
              throw new DOMException("MP3 conversion cancelled", "AbortError");
            }
            const pcm = await audioPreparation.prepareWindow({
              ...window,
              readStart: window.commitStart,
              readEnd: window.commitEnd,
            });
            await activeSession.appendPcm(pcm, { takeOwnership: true });
            completedWindows += 1;
            progress.value = Math.min(
              95,
              Math.round((completedWindows / totalWindows) * 90) + 2,
            );
          }
        } finally {
          await audioPreparation.close();
        }
      }

      const mp3Manifest = await activeSession.finalize();
      const blob = await audioAssets.getPartBlob(
        activeTemporaryId,
        mp3Manifest.parts[0],
      );
      progress.value = 100;
      return blob;
    } catch (error) {
      audioPreparation.abort();
      try {
        await activeSession?.cancel();
      } catch {
        // A finalized or already-failed session is cleaned below by asset id.
      }
      if (activeTemporaryId)
        await audioAssets.rollbackStaging(activeTemporaryId);
      activeTemporaryId = null;
      throw error;
    } finally {
      activeSession = null;
      isConverting.value = false;
    }
  }

  async function cancel() {
    if (!isConverting.value) return;
    cancelRequested = true;
    audioPreparation.abort();
    try {
      await activeSession?.cancel();
    } catch {
      // A finalized/failed session still has its temporary rows removed below.
    } finally {
      if (activeTemporaryId)
        await audioAssets.rollbackStaging(activeTemporaryId);
      activeTemporaryId = null;
    }
  }

  /** Remove temporary MP3 pages after the caller has handed the Blob to saveAs. */
  async function release() {
    if (!activeTemporaryId) return;
    const transcriptId = activeTemporaryId;
    activeTemporaryId = null;
    await audioAssets.rollbackStaging(transcriptId);
    progress.value = 0;
  }

  return { convert, cancel, release, isConverting, progress };
}

function normalizeSources(input) {
  if (input?.manifest) {
    if (!input.transcriptId)
      throw new Error("Transcript id is required for manifest audio");
    const manifest = normalizeTranscriptAudioManifest(input.manifest);
    return manifest.parts.map((part) => ({
      index: part.index,
      part,
      duration: part.end - part.start,
      mimeType: part.mimeType,
      blob: null,
    }));
  }
  throw new Error("Live recording audio is unavailable");
}

function createTemporaryExportId() {
  const suffix =
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  return `__mp3-export__${suffix}`;
}
