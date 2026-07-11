/**
 * Streaming VAD worker for live microphone transcription.
 * Receives continuous PCM chunks and emits utterance boundaries.
 *
 * Messages:
 *   Main → Worker:
 *     { type: "init" }
 *     { type: "feed", pcm: ArrayBuffer }        - 16kHz mono Float32 chunk
 *     { type: "flush" }                          - force-emit current utterance (on stop)
 *     { type: "reset" }                          - reset VAD state
 *     { type: "cancel" }                         - terminate
 *
 *   Worker → Main:
 *     { type: "ready" }
 *     { type: "speech-start", start: number }
 *     { type: "speech-end", utterance: ArrayBuffer, start: number, end: number }
 *     { type: "error", payload: { code: string, message: string } }
 */

/**
 * @typedef {{
 *   HEAP16: Int16Array,
 *   HEAP32: Int32Array,
 *   HEAPF32: Float32Array,
 *   _malloc(size: number): number,
 *   _free(ptr: number): void,
 *   _ten_vad_create(handlePtr: number, hopSamples: number, voiceThreshold: number): number,
 *   _ten_vad_process(handle: number, audioPtr: number, hopSamples: number, probPtr: number, flagPtr: number): number,
 *   _ten_vad_destroy(handlePtr: number): void,
 *   getValue?: (ptr: number, type: string) => number,
 * }} TenVadModule
 */

import createVADModule from "../../node_modules/@gooney-001/ten-vad-lib/ten_vad.js";

const SAMPLE_RATE = 16000;
const HOP_SAMPLES = 256;
const VOICE_THRESHOLD = 0.5;
const MIN_SPEECH_DURATION_S = 0.25;
const MAX_SILENCE_DURATION_S = 0.5;
const UTTERANCE_PRE_PADDING_S = 0.3;
const UTTERANCE_POST_PADDING_S = 0.1;

let vad = null;
let frame = null;
let cancelled = false;

let inSpeech = false;
let speechStartSample = 0;
let lastSpeechEndSample = 0;
let totalSamplesProcessed = 0;
let utteranceChunks = [];
let utteranceSampleCount = 0;
let prePadBuffer = [];
const PRE_PAD_SAMPLES = Math.ceil(UTTERANCE_PRE_PADDING_S * SAMPLE_RATE);

self.onmessage = async (e) => {
  const { type } = e.data;

  switch (type) {
    case "init": {
      try {
        vad = await createVadInstance();
        frame = new Int16Array(HOP_SAMPLES);
        cancelled = false;
        resetState();
        self.postMessage({ type: "ready" });
      } catch (err) {
        self.postMessage({
          type: "error",
          payload: {
            code: "VAD_INIT_FAILED",
            message: err?.message || String(err),
          },
        });
      }
      break;
    }

    case "feed": {
      if (!vad || cancelled) break;
      const pcm = new Float32Array(e.data.pcm);
      processPcm(pcm);
      break;
    }

    case "flush": {
      if (!vad || cancelled) break;
      flushCurrentUtterance();
      break;
    }

    case "reset": {
      resetState();
      break;
    }

    case "cancel": {
      cancelled = true;
      if (vad) {
        vad.destroy();
        vad = null;
      }
      break;
    }
  }
};

function processPcm(pcm) {
  updatePrePadBuffer(pcm);

  for (let offset = 0; offset < pcm.length; offset += HOP_SAMPLES) {
    const remaining = pcm.length - offset;
    if (remaining < HOP_SAMPLES) break;

    for (let i = 0; i < HOP_SAMPLES; i++) {
      frame[i] = floatToInt16(pcm[offset + i]);
    }

    vad.module.HEAP16.set(frame, vad.audioPtr >> 1);
    const result = vad.module._ten_vad_process(
      vad.handle,
      vad.audioPtr,
      HOP_SAMPLES,
      vad.probPtr,
      vad.flagPtr,
    );
    if (result !== 0) {
      self.postMessage({
        type: "error",
        payload: {
          code: "VAD_PROCESS_FAILED",
          message: `TenVAD process error ${result}`,
        },
      });
      return;
    }

    const isSpeech = readModuleValue(vad.module, vad.flagPtr, "i32") === 1;
    const samplePos = totalSamplesProcessed + offset;

    if (isSpeech) {
      if (!inSpeech) {
        inSpeech = true;
        speechStartSample = samplePos;
        utteranceChunks = [getPrePadAudio()];
        utteranceSampleCount = utteranceChunks[0].length;
        self.postMessage({
          type: "speech-start",
          start: speechStartSample / SAMPLE_RATE,
        });
      }
      lastSpeechEndSample = samplePos + HOP_SAMPLES;
    } else if (inSpeech) {
      const silenceDuration = (samplePos - lastSpeechEndSample) / SAMPLE_RATE;
      if (silenceDuration >= MAX_SILENCE_DURATION_S) {
        const speechDuration =
          (lastSpeechEndSample - speechStartSample) / SAMPLE_RATE;
        if (speechDuration >= MIN_SPEECH_DURATION_S) {
          emitUtterance();
        } else {
          utteranceChunks = [];
          utteranceSampleCount = 0;
        }
        inSpeech = false;
      }
    }
  }

  if (inSpeech) {
    utteranceChunks.push(new Float32Array(pcm));
    utteranceSampleCount += pcm.length;
  }

  totalSamplesProcessed += pcm.length;
}

function emitUtterance() {
  if (!utteranceChunks.length) return;

  const postPadSamples = Math.ceil(UTTERANCE_POST_PADDING_S * SAMPLE_RATE);
  const totalLen = utteranceSampleCount + postPadSamples;
  const merged = new Float32Array(totalLen);
  let writeOffset = 0;
  for (const chunk of utteranceChunks) {
    merged.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  const start = Math.max(0, speechStartSample - PRE_PAD_SAMPLES) / SAMPLE_RATE;
  const end = lastSpeechEndSample / SAMPLE_RATE;

  self.postMessage(
    { type: "speech-end", utterance: merged.buffer, start, end },
    { transfer: [merged.buffer] },
  );

  utteranceChunks = [];
  utteranceSampleCount = 0;
}

function flushCurrentUtterance() {
  if (inSpeech && utteranceChunks.length) {
    lastSpeechEndSample = totalSamplesProcessed;
    const speechDuration =
      (lastSpeechEndSample - speechStartSample) / SAMPLE_RATE;
    if (speechDuration >= MIN_SPEECH_DURATION_S) {
      emitUtterance();
    }
    inSpeech = false;
  }
  utteranceChunks = [];
  utteranceSampleCount = 0;
}

function updatePrePadBuffer(pcm) {
  prePadBuffer.push(new Float32Array(pcm));
  let totalLen = 0;
  for (const chunk of prePadBuffer) totalLen += chunk.length;
  while (totalLen > PRE_PAD_SAMPLES * 2 && prePadBuffer.length > 1) {
    totalLen -= prePadBuffer.shift().length;
  }
}

function getPrePadAudio() {
  if (!prePadBuffer.length) return new Float32Array(0);
  let totalLen = 0;
  for (const chunk of prePadBuffer) totalLen += chunk.length;
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of prePadBuffer) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const start = Math.max(0, merged.length - PRE_PAD_SAMPLES);
  return merged.subarray(start);
}

function resetState() {
  inSpeech = false;
  speechStartSample = 0;
  lastSpeechEndSample = 0;
  totalSamplesProcessed = 0;
  utteranceChunks = [];
  utteranceSampleCount = 0;
  prePadBuffer = [];
  cancelled = false;
}

async function createVadInstance() {
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
    HOP_SAMPLES,
    VOICE_THRESHOLD,
  );
  if (result !== 0) {
    vadModule._free(handlePtr);
    throw new Error(`TenVAD create failed with code ${result}`);
  }

  const handle = readModuleValue(vadModule, handlePtr, "i32");
  const audioPtr = vadModule._malloc(HOP_SAMPLES * 2);
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

function floatToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0
    ? Math.round(clamped * 32768)
    : Math.round(clamped * 32767);
}

function readModuleValue(module, ptr, type) {
  if (typeof module.getValue === "function") return module.getValue(ptr, type);
  if (type === "i32") return module.HEAP32[ptr >> 2];
  return module.HEAPF32[ptr >> 2];
}
