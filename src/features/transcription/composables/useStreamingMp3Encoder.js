import { normalizeTranscriptAudioManifest } from "@/features/transcription/lib/transcriptAudioManifest.js";
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";
import { useTranscriptAudioPageSink } from "./useTranscriptAudioPageSink.js";

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_BITRATE = 128_000;
const DEFAULT_PAGE_SIZE = 256 * 1024;
const DEFAULT_MAX_PENDING_PCM_CHUNKS = 4;

async function createMediabunnyEncoder(options) {
  const {
    AudioSample,
    AudioSampleSource,
    Mp3OutputFormat,
    Output,
    StreamTarget,
  } = await import("./mediabunnyMp3Runtime.js");

  const output = new Output({
    format: new Mp3OutputFormat({ xingHeader: true }),
    target: new StreamTarget(options.writable, {
      chunked: true,
      chunkSize: options.pageSize,
    }),
  });
  const source = new AudioSampleSource({
    codec: "mp3",
    bitrate: options.bitrate,
    bitrateMode: "constant",
  });
  output.addAudioTrack(source);
  let mimeTypePromise = Promise.resolve("audio/mpeg");

  const adapter = {
    mimeType: "audio/mpeg",
    async start() {
      await output.start();
      mimeTypePromise = output.getMimeType();
    },
    async addPcm(pcm, timestampSeconds) {
      const sample = new AudioSample({
        data: pcm,
        format: "f32",
        numberOfChannels: 1,
        sampleRate: options.sampleRate,
        timestamp: timestampSeconds,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    },
    async finalize() {
      await output.finalize();
      adapter.mimeType = await mimeTypePromise;
    },
    async cancel() {
      if (output.state !== "canceled" && output.state !== "finalized")
        await output.cancel();
    },
  };
  return adapter;
}

/**
 * One bounded PCM-to-MP3 session whose output is stored as temporary pages.
 * @param {{
 *   transcriptId: string,
 *   source: 'upload' | 'live',
 *   audioAssets?: ReturnType<useTranscriptionAudioAssets>,
 *   encoderFactory?: typeof createMediabunnyEncoder,
 *   sampleRate?: number,
 *   bitrate?: number,
 *   pageSize?: number,
 *   maxPendingPcmChunks?: number,
 * }} options
 */
export function useStreamingMp3Encoder(options) {
  if (!options.transcriptId) throw new Error("Transcript id is required");
  if (options.source !== "upload" && options.source !== "live") {
    throw new Error("Streaming MP3 source must be upload or live");
  }
  const sampleRate = positiveInteger(
    options.sampleRate ?? DEFAULT_SAMPLE_RATE,
    "sample rate",
  );
  const bitrate = positiveInteger(
    options.bitrate ?? DEFAULT_BITRATE,
    "bitrate",
  );
  const pageSize = positiveInteger(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    "page size",
  );
  const maxPendingPcmChunks = positiveInteger(
    options.maxPendingPcmChunks ?? DEFAULT_MAX_PENDING_PCM_CHUNKS,
    "maximum pending PCM chunks",
  );
  const audioAssets = options.audioAssets ?? useTranscriptionAudioAssets();
  const encoderFactory = options.encoderFactory ?? createMediabunnyEncoder;
  const sink = useTranscriptAudioPageSink({
    transcriptId: options.transcriptId,
    partIndex: 0,
    pageSize,
    mimeType: "audio/mpeg",
    audioAssets,
  });

  let status = "idle";
  let encoder = null;
  let reservedFrames = 0;
  let pendingPcmChunks = 0;
  let queueTail = Promise.resolve();
  let failure = null;
  let cleanupFailure = null;
  let cleanupPromise = Promise.resolve();
  let cleanupStarted = false;
  let encoderFinalized = false;

  async function cleanupFailedSession() {
    if (cleanupStarted) return cleanupPromise;
    cleanupStarted = true;
    cleanupPromise = (async () => {
      try {
        if (encoder && !encoderFinalized) await encoder.cancel();
      } catch (error) {
        cleanupFailure =
          error instanceof Error ? error : new Error(String(error));
      }
      try {
        await audioAssets.rollbackStaging(options.transcriptId);
      } catch (error) {
        cleanupFailure ??=
          error instanceof Error ? error : new Error(String(error));
      }
    })();
    return cleanupPromise;
  }

  function beginFailure(error) {
    if (status === "cancelled" || status === "finalized") return;
    if (!failure)
      failure = error instanceof Error ? error : new Error(String(error));
    status = "failed";
    cleanupPromise = queueTail.then(cleanupFailedSession, cleanupFailedSession);
  }

  async function start() {
    if (status !== "idle")
      throw new Error("Streaming MP3 session has already started");
    status = "starting";
    try {
      await audioAssets.beginStaging(options.transcriptId);
      encoder = await encoderFactory({
        writable: sink.writable,
        sampleRate,
        bitrate,
        pageSize,
      });
      await encoder.start();
      status = "running";
    } catch (error) {
      beginFailure(error);
      await cleanupPromise;
      throw error;
    }
  }

  /**
   * @param {Float32Array} pcm
   * @param {{ timestampSeconds?: number, takeOwnership?: boolean }} [appendOptions]
   */
  function appendPcm(pcm, appendOptions = {}) {
    if (status !== "running") {
      return Promise.reject(
        failure ?? new Error("Streaming MP3 session is not running"),
      );
    }
    if (!(pcm instanceof Float32Array) || pcm.length <= 0) {
      const error = new TypeError("PCM chunk must be a non-empty Float32Array");
      beginFailure(error);
      return Promise.reject(error);
    }
    const expectedTimestamp = reservedFrames / sampleRate;
    const timestampSeconds =
      appendOptions.timestampSeconds === undefined
        ? expectedTimestamp
        : Number(appendOptions.timestampSeconds);
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(timestampSeconds - expectedTimestamp) > 0.5 / sampleRate
    ) {
      const error = new Error(
        `PCM timestamp ${timestampSeconds} does not match expected ${expectedTimestamp}`,
      );
      beginFailure(error);
      return Promise.reject(error);
    }
    if (pendingPcmChunks >= maxPendingPcmChunks) {
      const error = new Error("Streaming MP3 PCM queue exceeded its bound");
      beginFailure(error);
      return Promise.reject(error);
    }

    const ownedPcm = appendOptions.takeOwnership ? pcm : pcm.slice();
    reservedFrames += ownedPcm.length;
    pendingPcmChunks += 1;
    const operation = queueTail.then(async () => {
      if (status === "cancelled") {
        throw new DOMException(
          "Streaming MP3 encoding cancelled",
          "AbortError",
        );
      }
      if (failure) throw failure;
      await encoder.addPcm(ownedPcm, timestampSeconds);
    });
    const exposed = operation
      .catch((error) => {
        beginFailure(error);
        throw error;
      })
      .finally(() => {
        pendingPcmChunks -= 1;
      });
    queueTail = exposed.catch(() => undefined);
    return exposed;
  }

  async function finalize() {
    if (status !== "running")
      throw failure ?? new Error("Streaming MP3 session is not running");
    status = "finalizing";
    try {
      await queueTail;
      if (failure) throw failure;
      await encoder.finalize();
      encoderFinalized = true;
      const partStats = await sink.getStats();
      if (partStats.fragmentCount <= 0 || partStats.sizeBytes <= 0) {
        throw new Error("Streaming MP3 encoder produced no audio bytes");
      }
      const duration = reservedFrames / sampleRate;
      const manifest = normalizeTranscriptAudioManifest({
        version: 1,
        duration,
        source: options.source,
        parts: [
          {
            index: 0,
            start: 0,
            end: duration,
            mimeType: encoder.mimeType || "audio/mpeg",
            sizeBytes: partStats.sizeBytes,
            fragmentCount: partStats.fragmentCount,
          },
        ],
      });
      status = "finalized";
      return manifest;
    } catch (error) {
      beginFailure(error);
      await cleanupPromise;
      throw error;
    }
  }

  async function cancel() {
    if (status === "cancelled") return;
    if (status === "finalized")
      throw new Error("Finalized MP3 session cannot be cancelled");
    status = "cancelled";
    try {
      if (encoder && !encoderFinalized) await encoder.cancel();
      await queueTail;
    } finally {
      await audioAssets.rollbackStaging(options.transcriptId);
    }
  }

  return {
    start,
    appendPcm,
    finalize,
    cancel,
    getState: () => ({
      status,
      pendingPcmChunks,
      encodedFrames: reservedFrames,
      durationSeconds: reservedFrames / sampleRate,
      failure,
      cleanupFailure,
      sink: sink.getDiagnostics(),
    }),
  };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${label} must be positive`);
  return number;
}
