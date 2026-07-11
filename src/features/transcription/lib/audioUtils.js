/**
 * Audio processing utilities for transcription.
 * All functions operate on raw PCM data — no DOM or Web Audio API dependency.
 */

const TARGET_SAMPLE_RATE = 16000;

/**
 * Resample an AudioBuffer to 16kHz mono Float32Array.
 * Uses OfflineAudioContext for high-quality resampling.
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<Float32Array>}
 */
export async function resampleTo16kMono(audioBuffer) {
  const targetLength = Math.round(
    (audioBuffer.length * TARGET_SAMPLE_RATE) / audioBuffer.sampleRate,
  );

  const offlineCtx = new OfflineAudioContext(
    1,
    targetLength,
    TARGET_SAMPLE_RATE,
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Decode a WAV/audio file blob directly via Web Audio API.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeAudioData(arrayBuffer) {
  const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  try {
    return await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }
}

/**
 * Check if a file can be decoded directly by the Web Audio API
 * without needing FFmpeg transcoding.
 * @param {File} file
 * @returns {boolean}
 */
export function canDecodeNatively(file) {
  const nativeTypes = [
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
  ];
  if (nativeTypes.includes(file.type)) return true;

  // Fallback: check extension
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ["wav", "mp3", "m4a", "aac", "ogg", "webm", "flac"].includes(ext);
}

/**
 * Check if a file is a video format that requires audio extraction.
 * @param {File} file
 * @returns {boolean}
 */
export function isVideoFile(file) {
  if (file.type.startsWith("video/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ["mp4", "mov", "mkv", "avi", "webm"].includes(ext);
}

/**
 * Encode mono Float32 PCM as a 16-bit PCM WAV blob.
 * @param {Float32Array} pcm
 * @param {{ sampleRate?: number }} [options]
 * @returns {Blob}
 */
export function createWavBlobFromPcm(pcm, options = {}) {
  const sampleRate = options.sampleRate || TARGET_SAMPLE_RATE;
  const channelCount = 1;
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] || 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {string} value
 */
function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
