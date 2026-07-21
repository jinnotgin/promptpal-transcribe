import { normalizeTranscriptAudioManifest } from "@/features/transcription/lib/transcriptAudioManifest.js";
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";
import { useTranscriptAudioPageSink } from "./useTranscriptAudioPageSink.js";

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_BITRATE = 64_000;
const DEFAULT_PAGE_SIZE = 256 * 1024;
const DEFAULT_MAX_SAMPLE_SECONDS = 10;
const DEFAULT_CLUSTER_SECONDS = 5;
const WEBM_OPUS_MIME_TYPE = "audio/webm;codecs=opus";

async function loadMediabunnyRuntime() {
  return import("./mediabunnyWebmRuntime.js");
}

/**
 * Probe the exact native WebCodecs configuration used by the streaming writer.
 * Loading and probing are both allowed to fail so unsupported browsers retain
 * the existing independently-finalized upload-window fallback.
 * @param {{
 *   runtimeLoader?: () => Promise<Pick<typeof import('./mediabunnyWebmRuntime.js'), 'canEncodeAudio'>>,
 *   sampleRate?: number,
 *   bitrate?: number,
 * }} [options]
 */
export async function canUseStreamingWebmEncoder(options = {}) {
  const sampleRate = positiveInteger(
    options.sampleRate ?? DEFAULT_SAMPLE_RATE,
    "sample rate",
  );
  const bitrate = positiveInteger(
    options.bitrate ?? DEFAULT_BITRATE,
    "bitrate",
  );
  try {
    const runtime = await (options.runtimeLoader ?? loadMediabunnyRuntime)();
    return await runtime.canEncodeAudio("opus", {
      numberOfChannels: 1,
      sampleRate,
      bitrate,
    });
  } catch {
    return false;
  }
}

async function createMediabunnyEncoder(options) {
  const {
    AudioSample,
    AudioSampleSource,
    Output,
    StreamTarget,
    WebMOutputFormat,
  } = await loadMediabunnyRuntime();
  const output = new Output({
    format: new WebMOutputFormat({
      minimumClusterDuration: options.clusterSeconds,
    }),
    target: new StreamTarget(options.writable, {
      chunked: true,
      chunkSize: options.pageSize,
    }),
  });
  const source = new AudioSampleSource({
    codec: "opus",
    bitrate: options.bitrate,
    bitrateMode: "variable",
  });
  output.addAudioTrack(source);
  let mimeTypePromise = Promise.resolve(WEBM_OPUS_MIME_TYPE);

  const adapter = {
    mimeType: WEBM_OPUS_MIME_TYPE,
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
 * Write one upload as one seekable WebM/Opus asset. PCM is fed in small,
 * awaited views and encoded bytes are patched into fixed-size IndexedDB pages,
 * so neither the source PCM nor the finished WebM is assembled in memory.
 *
 * The caller owns the staging lease; failed and cancelled sessions remove all
 * staged pages.
 * @param {{
 *   transcriptId: string,
 *   audioAssets?: ReturnType<useTranscriptionAudioAssets>,
 *   encoderFactory?: typeof createMediabunnyEncoder,
 *   sampleRate?: number,
 *   bitrate?: number,
 *   pageSize?: number,
 *   maxSampleSeconds?: number,
 *   clusterSeconds?: number,
 * }} options
 */
export function useStreamingWebmEncoder(options) {
  if (!options.transcriptId) throw new Error("Transcript id is required");
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
  const maxSampleSeconds = positiveNumber(
    options.maxSampleSeconds ?? DEFAULT_MAX_SAMPLE_SECONDS,
    "maximum sample duration",
  );
  const clusterSeconds = positiveNumber(
    options.clusterSeconds ?? DEFAULT_CLUSTER_SECONDS,
    "cluster duration",
  );
  const maxSampleFrames = Math.max(
    1,
    Math.floor(sampleRate * maxSampleSeconds),
  );
  const audioAssets = options.audioAssets ?? useTranscriptionAudioAssets();
  const encoderFactory = options.encoderFactory ?? createMediabunnyEncoder;
  const sink = useTranscriptAudioPageSink({
    transcriptId: options.transcriptId,
    partIndex: 0,
    pageSize,
    mimeType: WEBM_OPUS_MIME_TYPE,
    audioAssets,
  });

  let status = "idle";
  let encoder = null;
  let encodedFrames = 0;
  let pendingPcmChunks = 0;
  let failure = null;
  let encoderFinalized = false;
  let cleanupPromise = null;

  async function cleanupFailedSession() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        if (encoder && !encoderFinalized) await encoder.cancel();
      } finally {
        await audioAssets.rollbackStaging(options.transcriptId);
      }
    })();
    return cleanupPromise;
  }

  async function fail(error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
    status = "failed";
    await cleanupFailedSession();
    return failure;
  }

  async function start() {
    if (status !== "idle")
      throw new Error("Streaming WebM session has already started");
    status = "starting";
    try {
      encoder = await encoderFactory({
        writable: sink.writable,
        sampleRate,
        bitrate,
        pageSize,
        clusterSeconds,
      });
      await encoder.start();
      status = "running";
    } catch (error) {
      throw await fail(error);
    }
  }

  /**
   * @param {Float32Array} pcm
   * @param {{ timestampSeconds?: number }} [appendOptions]
   */
  async function appendPcm(pcm, appendOptions = {}) {
    if (status !== "running") {
      throw failure ?? new Error("Streaming WebM session is not running");
    }
    if (!(pcm instanceof Float32Array) || pcm.length <= 0) {
      throw await fail(
        new TypeError("PCM chunk must be a non-empty Float32Array"),
      );
    }
    if (pendingPcmChunks > 0) {
      throw await fail(
        new Error("Streaming WebM accepts one awaited PCM append at a time"),
      );
    }
    const expectedTimestamp = encodedFrames / sampleRate;
    const timestampSeconds =
      appendOptions.timestampSeconds === undefined
        ? expectedTimestamp
        : Number(appendOptions.timestampSeconds);
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(timestampSeconds - expectedTimestamp) > 0.5 / sampleRate
    ) {
      throw await fail(
        new Error(
          `PCM timestamp ${timestampSeconds} does not match expected ${expectedTimestamp}`,
        ),
      );
    }

    pendingPcmChunks = 1;
    try {
      for (let offset = 0; offset < pcm.length; offset += maxSampleFrames) {
        // Mediabunny passes an AudioSample view's complete backing ArrayBuffer
        // to AudioData, so each bounded input must own exactly its sample range.
        const sample = pcm.slice(
          offset,
          Math.min(pcm.length, offset + maxSampleFrames),
        );
        await encoder.addPcm(sample, encodedFrames / sampleRate);
        encodedFrames += sample.length;
      }
    } catch (error) {
      throw await fail(error);
    } finally {
      pendingPcmChunks = 0;
    }
  }

  async function finalize() {
    if (status !== "running") {
      throw failure ?? new Error("Streaming WebM session is not running");
    }
    status = "finalizing";
    try {
      await encoder.finalize();
      encoderFinalized = true;
      const partStats = await sink.getStats();
      if (partStats.fragmentCount <= 0 || partStats.sizeBytes <= 0) {
        throw new Error("Streaming WebM encoder produced no audio bytes");
      }
      const duration = encodedFrames / sampleRate;
      const manifest = normalizeTranscriptAudioManifest({
        version: 1,
        duration,
        source: "upload",
        parts: [
          {
            index: 0,
            start: 0,
            end: duration,
            mimeType: encoder.mimeType || WEBM_OPUS_MIME_TYPE,
            sizeBytes: partStats.sizeBytes,
            fragmentCount: partStats.fragmentCount,
          },
        ],
      });
      status = "finalized";
      return manifest;
    } catch (error) {
      throw await fail(error);
    }
  }

  async function cancel() {
    if (status === "cancelled" || status === "failed") {
      await cleanupFailedSession();
      return;
    }
    if (status === "finalized")
      throw new Error("Finalized WebM session cannot be cancelled");
    status = "cancelled";
    await cleanupFailedSession();
  }

  return {
    start,
    appendPcm,
    finalize,
    cancel,
    getState: () => ({
      status,
      pendingPcmChunks,
      encodedFrames,
      durationSeconds: encodedFrames / sampleRate,
      failure,
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

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${label} must be positive`);
  return number;
}
