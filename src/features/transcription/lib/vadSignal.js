/**
 * TenVAD-based Voice Activity Detection.
 * Operates on 16kHz mono Float32Array PCM and returns reference-style
 * pre-merged transcription chunks.
 */

import createVADModule from "../../../../node_modules/@gooney-001/ten-vad-lib/ten_vad.js";
import {
  createVadChunks,
  initTranscriptProcessingCore,
} from "./transcriptProcessingCore.js";

/** @typedef {{ start: number, end: number, preChunked?: boolean }} SpeechRegion */

const SAMPLE_RATE = 16000;
const TEN_VAD_HOP_SAMPLES = 256;
const VOICE_THRESHOLD = 0.5;
const MIN_SPEECH_DURATION_MS = 250;
const MAX_SILENCE_DURATION_MS = 400;
const VAD_WINDOW_SAMPLES = 30 * SAMPLE_RATE;
const VAD_OVERLAP_SAMPLES = 24_000;
const MAX_CHUNK_DURATION_SECONDS = 90;
const CHUNK_PADDING_SECONDS = 3;
const ENABLE_TRANSCRIPTION_DIAGNOSTICS = import.meta.env.DEV;

/**
 * Detect speech regions in 16kHz mono audio.
 * @param {Float32Array} pcm
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<SpeechRegion[]>}
 */
export async function detectSpeechRegions(pcm, onProgress) {
  if (!pcm.length) return [];

  await initTranscriptProcessingCore(
    "/wasm/transcript-processing-core_bg.wasm",
  );
  const vad = await createVad();
  const rawRegions = [];

  try {
    for (const window of streamWindowsWithOverlap(
      pcm,
      VAD_WINDOW_SAMPLES,
      VAD_OVERLAP_SAMPLES,
    )) {
      const regions = runTenVadWindow(vad, window.floats);
      for (const region of regions) {
        rawRegions.push({
          start: region.start + window.sliceStart / SAMPLE_RATE,
          end: region.end + window.sliceStart / SAMPLE_RATE,
        });
      }
      onProgress?.(
        Math.min(100, Math.max(0, (window.sliceEnd / pcm.length) * 100)),
      );
    }
  } finally {
    vad.destroy();
  }

  const chunks = createVadChunks(
    rawRegions,
    MAX_CHUNK_DURATION_SECONDS,
    CHUNK_PADDING_SECONDS,
  );
  onProgress?.(100);

  if (ENABLE_TRANSCRIPTION_DIAGNOSTICS) {
    console.info("[transcription][vad]", {
      rawRegionCount: rawRegions.length,
      chunkCount: chunks.length,
      firstRawRegions: rawRegions.slice(0, 8),
      firstChunks: chunks.slice(0, 8),
    });
  }

  return chunks.map((chunk) => ({ ...chunk, preChunked: true }));
}

async function createVad() {
  const createModule =
    /** @type {(options: Record<string, unknown>) => Promise<unknown>} */ (
      createVADModule
    );
  const module = await createModule({
    locateFile: (filename) =>
      filename.endsWith(".wasm") ? "/wasm/ten_vad.wasm" : filename,
    noInitialRun: false,
    noExitRuntime: true,
  });

  const vadModule = /** @type {TenVadModule} */ (module);
  const handlePtr = vadModule._malloc(4);
  const result = vadModule._ten_vad_create(
    handlePtr,
    TEN_VAD_HOP_SAMPLES,
    VOICE_THRESHOLD,
  );
  if (result !== 0) {
    vadModule._free(handlePtr);
    throw new Error(`TenVAD create failed with code ${result}`);
  }

  const handle = readModuleValue(vadModule, handlePtr, "i32");
  const audioPtr = vadModule._malloc(TEN_VAD_HOP_SAMPLES * 2);
  const probPtr = vadModule._malloc(4);
  const flagPtr = vadModule._malloc(4);

  return {
    module: vadModule,
    handlePtr,
    handle,
    audioPtr,
    probPtr,
    flagPtr,
    destroy() {
      vadModule._ten_vad_destroy(handlePtr);
      vadModule._free(handlePtr);
      vadModule._free(audioPtr);
      vadModule._free(probPtr);
      vadModule._free(flagPtr);
    },
  };
}

/**
 * @param {Awaited<ReturnType<typeof createVad>>} vad
 * @param {Float32Array} floats
 * @returns {SpeechRegion[]}
 */
function runTenVadWindow(vad, floats) {
  const regions = [];
  const frame = new Int16Array(TEN_VAD_HOP_SAMPLES);
  const minSpeechSeconds = MIN_SPEECH_DURATION_MS / 1000;
  const maxSilenceSeconds = MAX_SILENCE_DURATION_MS / 1000;
  const totalFrames = Math.floor(floats.length / TEN_VAD_HOP_SAMPLES);
  let inSpeech = false;
  let speechStart = 0;
  let lastSpeechEnd = 0;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    const sampleOffset = frameIndex * TEN_VAD_HOP_SAMPLES;
    for (let i = 0; i < TEN_VAD_HOP_SAMPLES; i++) {
      frame[i] = floatToInt16(floats[sampleOffset + i] || 0);
    }

    vad.module.HEAP16.set(frame, vad.audioPtr >> 1);
    const result = vad.module._ten_vad_process(
      vad.handle,
      vad.audioPtr,
      TEN_VAD_HOP_SAMPLES,
      vad.probPtr,
      vad.flagPtr,
    );
    if (result !== 0)
      throw new Error(`TenVAD process failed with code ${result}`);

    const isSpeech = readModuleValue(vad.module, vad.flagPtr, "i32") === 1;
    const frameStart = sampleOffset / SAMPLE_RATE;
    const frameEnd = (sampleOffset + TEN_VAD_HOP_SAMPLES) / SAMPLE_RATE;

    if (isSpeech) {
      if (!inSpeech) {
        inSpeech = true;
        speechStart = frameStart;
      }
      lastSpeechEnd = frameEnd;
    } else if (inSpeech && frameStart - lastSpeechEnd >= maxSilenceSeconds) {
      if (lastSpeechEnd - speechStart >= minSpeechSeconds) {
        regions.push({ start: speechStart, end: lastSpeechEnd });
      }
      inSpeech = false;
    }
  }

  if (inSpeech) {
    const end = lastSpeechEnd || floats.length / SAMPLE_RATE;
    if (end - speechStart >= minSpeechSeconds) {
      regions.push({ start: speechStart, end });
    }
  }

  return regions;
}

/**
 * @param {Float32Array} pcm
 * @param {number} windowSamples
 * @param {number} overlapSamples
 */
function* streamWindowsWithOverlap(pcm, windowSamples, overlapSamples) {
  let offset = 0;
  let previousOverlap = new Float32Array(0);

  while (offset < pcm.length) {
    const end = Math.min(offset + windowSamples, pcm.length);
    const current = pcm.subarray(offset, end);
    const floats = new Float32Array(previousOverlap.length + current.length);
    if (previousOverlap.length) floats.set(previousOverlap, 0);
    floats.set(current, previousOverlap.length);

    yield {
      floats,
      sliceStart: Math.max(0, offset - previousOverlap.length),
      sliceEnd: end,
    };

    if (end >= pcm.length) break;
    previousOverlap = current.slice(
      Math.max(0, current.length - overlapSamples),
    );
    offset = end;
  }
}

/**
 * @param {number} sample
 */
function floatToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0
    ? Math.round(clamped * 32768)
    : Math.round(clamped * 32767);
}

/**
 * @typedef {{
 *   HEAP16: Int16Array,
 *   HEAP32: Int32Array,
 *   HEAPF32: Float32Array,
 *   getValue?: (ptr: number, type: string) => number,
 *   _malloc: (size: number) => number,
 *   _free: (ptr: number) => void,
 *   _ten_vad_create: (handlePtr: number, hopSize: number, threshold: number) => number,
 *   _ten_vad_process: (handle: number, audioPtr: number, audioSize: number, probPtr: number, flagPtr: number) => number,
 *   _ten_vad_destroy: (handlePtr: number) => void,
 * }} TenVadModule
 */

/**
 * @param {TenVadModule} module
 * @param {number} ptr
 * @param {'i32' | 'float'} type
 */
function readModuleValue(module, ptr, type) {
  if (typeof module.getValue === "function") return module.getValue(ptr, type);
  if (type === "i32") return module.HEAP32[ptr >> 2];
  return module.HEAPF32[ptr >> 2];
}
