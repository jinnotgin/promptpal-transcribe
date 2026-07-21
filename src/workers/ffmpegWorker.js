/**
 * FFmpeg WASM worker for bounded transcription preparation and WebM/Opus
 * review proxies.
 */

import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";

/** @type {FFmpeg | null} */
let ffmpeg = null;
let cancelled = false;
let mountedInputPath = null;
const INPUT_MOUNT = "/mounted-input";
const workerScope =
  /** @type {{ postMessage: (message: unknown, transfer?: Transferable[]) => void, onmessage: ((ev: MessageEvent) => unknown) | null }} */ (
    self
  );

async function initFFmpeg() {
  if (ffmpeg) return;
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
    wasmURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
  });
}

/** @param {File} file @param {number | null} durationHint */
async function openFile(file, durationHint) {
  await initFFmpeg();
  await closeFile();
  try {
    await ffmpeg.createDir(INPUT_MOUNT);
  } catch {
    // The directory can survive an unmount in the same worker session.
  }
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, INPUT_MOUNT);
  mountedInputPath = `${INPUT_MOUNT}/${file.name}`;
  const hintedDuration = Number(durationHint);
  return {
    duration:
      Number.isFinite(hintedDuration) && hintedDuration > 0
        ? hintedDuration
        : await probeDuration(mountedInputPath),
  };
}

async function closeFile() {
  if (!ffmpeg || !mountedInputPath) return;
  try {
    await ffmpeg.unmount(INPUT_MOUNT);
  } catch {
    // Worker termination remains the deterministic cleanup fallback.
  }
  mountedInputPath = null;
}

/** @param {string} inputPath */
async function probeDuration(inputPath) {
  const outputName = "duration.txt";
  try {
    await ffmpeg.ffprobe([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
      "-o",
      outputName,
    ]);
    const output = await ffmpeg.readFile(outputName, "utf8");
    const duration = Number(String(output).trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Unable to determine media duration");
    }
    return duration;
  } finally {
    await deleteFileIfPresent(outputName);
  }
}

async function prepareWindow({ start, duration, windowIndex }) {
  if (!mountedInputPath) throw new Error("No media file is mounted");
  cancelled = false;
  const outputName = `pcm-window-${windowIndex}.f32`;
  try {
    await ffmpeg.exec([
      "-ss",
      String(Math.max(0, Number(start) || 0)),
      "-i",
      mountedInputPath,
      "-t",
      String(Math.max(0, Number(duration) || 0)),
      "-vn",
      "-acodec",
      "pcm_f32le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "f32le",
      outputName,
    ]);
    if (cancelled) throw new DOMException("Aborted", "AbortError");
    return {
      pcmData: await readArrayBuffer(outputName),
    };
  } finally {
    await deleteFileIfPresent(outputName);
  }
}

async function prepareWindowWithProxy(payload) {
  const prepared = await prepareWindow(payload);
  if (!mountedInputPath) throw new Error("No media file is mounted");
  const outputName = `proxy-part-${payload.windowIndex}.webm`;
  try {
    await ffmpeg.exec([
      "-ss",
      String(Math.max(0, Number(payload.commitStart) || 0)),
      "-i",
      mountedInputPath,
      "-t",
      String(Math.max(0, Number(payload.commitDuration) || 0)),
      "-vn",
      "-map_metadata",
      "-1",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-codec:a",
      "libopus",
      "-b:a",
      "64k",
      "-vbr",
      "on",
      "-f",
      "webm",
      outputName,
    ]);
    if (cancelled) throw new DOMException("Aborted", "AbortError");
    return {
      ...prepared,
      proxyData: await readArrayBuffer(outputName),
      mimeType: "audio/webm;codecs=opus",
    };
  } finally {
    await deleteFileIfPresent(outputName);
  }
}

/** @param {string} name */
async function readArrayBuffer(name) {
  const outputData = await ffmpeg.readFile(name);
  const bytes =
    typeof outputData === "string"
      ? new TextEncoder().encode(outputData)
      : outputData;
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

/** @param {string} name */
async function deleteFileIfPresent(name) {
  try {
    await ffmpeg?.deleteFile(name);
  } catch {
    // Ignore absent temporary output.
  }
}

workerScope.onmessage = async (event) => {
  const { type, payload, requestId } = event.data;
  try {
    switch (type) {
      case "open-file": {
        const result = await openFile(payload.file, payload.duration);
        workerScope.postMessage({
          type: "file-opened",
          requestId,
          payload: result,
        });
        break;
      }
      case "prepare-window": {
        const result = await prepareWindow(payload);
        workerScope.postMessage(
          { type: "window-complete", requestId, payload: result },
          [result.pcmData],
        );
        break;
      }
      case "prepare-window-with-proxy": {
        const result = await prepareWindowWithProxy(payload);
        workerScope.postMessage(
          { type: "window-proxy-complete", requestId, payload: result },
          [result.pcmData, result.proxyData],
        );
        break;
      }
      case "close-file":
        await closeFile();
        workerScope.postMessage({
          type: "file-closed",
          requestId,
          payload: {},
        });
        break;
      case "init":
        await initFFmpeg();
        workerScope.postMessage({ type: "ready" });
        break;
      case "cancel":
        cancelled = true;
        break;
    }
  } catch (error) {
    if (cancelled) return;
    workerScope.postMessage({
      type: "error",
      requestId,
      payload: {
        code: errorCodeFor(type),
        message: errorMessage(error),
      },
    });
  }
};

function errorCodeFor(type) {
  if (type === "open-file") return "FFMPEG_OPEN_FAILED";
  if (type === "prepare-window-with-proxy") return "FFMPEG_PROXY_FAILED";
  if (type === "prepare-window") return "FFMPEG_WINDOW_FAILED";
  if (type === "init") return "FFMPEG_INIT_FAILED";
  return "FFMPEG_FAILED";
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown FFmpeg error";
  }
}
