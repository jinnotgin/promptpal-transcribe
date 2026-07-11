/**
 * FFmpeg WASM worker — single-threaded (no SharedArrayBuffer / COOP/COEP required).
 *
 * Messages:
 *   Main → Worker:
 *     { type: "init" }
 *     { type: "process", payload: { fileData: ArrayBuffer, fileName: string } }
 *     { type: "export-mp3", payload: { wavData: ArrayBuffer, fileName: string } }
 *     { type: "export-audio-mp3", payload: { fileData: ArrayBuffer, fileName: string, mimeType?: string } }
 *     { type: "cancel" }
 *
 *   Worker → Main:
 *     { type: "progress", payload: { percent: number } }
 *     { type: "complete", payload: { wavData: ArrayBuffer } }
 *     { type: "mp3-complete", payload: { mp3Data: ArrayBuffer } }
 *     { type: "error", payload: { code: string, message: string } }
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

/** @type {FFmpeg | null} */
let ffmpeg = null;
let cancelled = false;
const workerScope =
  /** @type {{ postMessage: (message: unknown, transfer?: Transferable[]) => void, onmessage: ((ev: MessageEvent) => unknown) | null }} */ (
    self
  );

async function initFFmpeg() {
  if (ffmpeg) return;
  ffmpeg = new FFmpeg();

  ffmpeg.on("progress", ({ progress }) => {
    if (!cancelled) {
      workerScope.postMessage({
        type: "progress",
        payload: { percent: Math.round(progress * 100) },
      });
    }
  });

  await ffmpeg.load({
    coreURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
    wasmURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
  });
}

/**
 * Extract audio from input file and convert to 16kHz mono WAV.
 * @param {ArrayBuffer} fileData
 * @param {string} fileName
 */
async function processFile(fileData, fileName) {
  cancelled = false;

  await initFFmpeg();
  if (cancelled) return;

  const inputName = `input_${fileName}`;
  const outputName = "output.wav";

  await ffmpeg.writeFile(inputName, await fetchFile(new Blob([fileData])));
  if (cancelled) return;

  // Convert to 16kHz mono 16-bit PCM WAV
  await ffmpeg.exec([
    "-i",
    inputName,
    "-vn", // drop video stream
    "-acodec",
    "pcm_s16le", // 16-bit PCM
    "-ar",
    "16000", // 16kHz sample rate
    "-ac",
    "1", // mono
    outputName,
  ]);

  if (cancelled) return;

  const outputData = await ffmpeg.readFile(outputName);

  // Clean up
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  const bytes =
    typeof outputData === "string"
      ? new TextEncoder().encode(outputData)
      : outputData;
  const buffer = bytes.buffer;
  workerScope.postMessage({ type: "complete", payload: { wavData: buffer } }, [
    buffer,
  ]);
}

/**
 * Convert staged live recording WAV data to MP3.
 * @param {ArrayBuffer} wavData
 * @param {string} fileName
 */
async function exportMp3(wavData, fileName) {
  cancelled = false;

  await initFFmpeg();
  if (cancelled) return;

  const inputName = `live_input_${safeInputName(fileName, "wav")}`;
  const outputName = "live-recording.mp3";

  await ffmpeg.writeFile(
    inputName,
    await fetchFile(new Blob([wavData], { type: "audio/wav" })),
  );
  if (cancelled) return;

  await ffmpeg.exec([
    "-i",
    inputName,
    "-vn",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "128k",
    outputName,
  ]);

  if (cancelled) return;

  const outputData = await ffmpeg.readFile(outputName);

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  const bytes =
    typeof outputData === "string"
      ? new TextEncoder().encode(outputData)
      : outputData;
  const buffer = bytes.buffer;
  workerScope.postMessage(
    { type: "mp3-complete", payload: { mp3Data: buffer } },
    [buffer],
  );
}

/**
 * Convert playable audio data to MP3.
 * @param {ArrayBuffer} fileData
 * @param {string} fileName
 * @param {string} [mimeType]
 */
async function exportAudioMp3(fileData, fileName, mimeType) {
  cancelled = false;

  await initFFmpeg();
  if (cancelled) return;

  const inputName = `audio_input_${safeInputName(fileName, "audio")}`;
  const outputName = "live-recording.mp3";

  await ffmpeg.writeFile(
    inputName,
    await fetchFile(new Blob([fileData], { type: mimeType || "" })),
  );
  if (cancelled) return;

  await ffmpeg.exec([
    "-i",
    inputName,
    "-vn",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "128k",
    outputName,
  ]);

  if (cancelled) return;

  const outputData = await ffmpeg.readFile(outputName);

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  const bytes =
    typeof outputData === "string"
      ? new TextEncoder().encode(outputData)
      : outputData;
  const buffer = bytes.buffer;
  workerScope.postMessage(
    { type: "mp3-complete", payload: { mp3Data: buffer } },
    [buffer],
  );
}

/**
 * @param {string} fileName
 * @param {string} fallbackExtension
 * @returns {string}
 */
function safeInputName(fileName, fallbackExtension) {
  const name = `${fileName || `input.${fallbackExtension}`}`.replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  return name.includes(".") ? name : `${name}.${fallbackExtension}`;
}

workerScope.onmessage = async (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case "init":
      try {
        await initFFmpeg();
        workerScope.postMessage({ type: "ready" });
      } catch (err) {
        workerScope.postMessage({
          type: "error",
          payload: { code: "FFMPEG_INIT_FAILED", message: err.message },
        });
      }
      break;

    case "process":
      try {
        await processFile(payload.fileData, payload.fileName);
      } catch (err) {
        if (!cancelled) {
          workerScope.postMessage({
            type: "error",
            payload: { code: "FFMPEG_PROCESS_FAILED", message: err.message },
          });
        }
      }
      break;

    case "export-mp3":
      try {
        await exportMp3(payload.wavData, payload.fileName);
      } catch (err) {
        if (!cancelled) {
          workerScope.postMessage({
            type: "error",
            payload: { code: "FFMPEG_MP3_EXPORT_FAILED", message: err.message },
          });
        }
      }
      break;

    case "export-audio-mp3":
      try {
        await exportAudioMp3(
          payload.fileData,
          payload.fileName,
          payload.mimeType,
        );
      } catch (err) {
        if (!cancelled) {
          workerScope.postMessage({
            type: "error",
            payload: {
              code: "FFMPEG_AUDIO_MP3_EXPORT_FAILED",
              message: errorMessage(err),
            },
          });
        }
      }
      break;

    case "cancel":
      cancelled = true;
      break;
  }
};

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown FFmpeg error";
  }
}
