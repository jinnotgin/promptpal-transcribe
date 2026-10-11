/**
 * Checks the browser SenseVoice pipeline against sherpa-onnx on real audio.
 *
 * Runs src/features/transcription/lib/senseVoiceRecognizer.js through
 * onnxruntime-web (WASM, in Node) and compares text and token onsets with a
 * reference.json written by sherpa-onnx's OfflineRecognizer.from_sense_voice.
 * Not part of `npm test`: it needs the 239 MB model.
 *
 *   node scripts/sensevoice-parity.js <dir>
 *
 * <dir> holds model.int8.onnx, tokens.txt, <name>.wav (16 kHz, 16-bit PCM)
 * and reference.json ({ [name]: { text, timestamps } }).
 */

import fs from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-web";
import { readOnnxMetadata } from "../src/features/transcription/lib/onnxMetadata.js";
import { parseSenseVoiceMetadata } from "../src/features/transcription/lib/senseVoiceFrontend.js";
import { parseTokens } from "../src/features/transcription/lib/senseVoiceDecoding.js";
import { createSenseVoiceRecognizer } from "../src/features/transcription/lib/senseVoiceRecognizer.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/sensevoice-parity.js <dir>");
  process.exit(2);
}

/**
 * @param {Buffer} buffer
 * @returns {Float32Array}
 */
function readPcm16Wav(buffer) {
  let offset = 12;
  while (offset < buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768;
      }
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

const modelBuffer = fs.readFileSync(path.join(dir, "model.int8.onnx"));
const modelBytes = new Uint8Array(
  modelBuffer.buffer,
  modelBuffer.byteOffset,
  modelBuffer.byteLength,
);
const metadata = parseSenseVoiceMetadata(
  readOnnxMetadata(modelBytes.slice().buffer),
);
const symbols = parseTokens(
  fs.readFileSync(path.join(dir, "tokens.txt"), "utf8"),
);
const reference = JSON.parse(
  fs.readFileSync(path.join(dir, "reference.json"), "utf8"),
);

const loadStart = performance.now();
const session = await ort.InferenceSession.create(modelBytes, {
  executionProviders: ["wasm"],
});
console.log(
  `session ready in ${((performance.now() - loadStart) / 1000).toFixed(1)}s`,
);

const recognizer = createSenseVoiceRecognizer({
  session,
  Tensor: ort.Tensor,
  metadata,
  symbols,
  language: "auto",
});

let failures = 0;
for (const [name, expected] of Object.entries(reference)) {
  const pcm = readPcm16Wav(fs.readFileSync(path.join(dir, `${name}.wav`)));
  const start = performance.now();
  const result = await recognizer.transcribe(pcm, 0);
  const seconds = (performance.now() - start) / 1000;
  const textMatches = expected.text === result.text;
  // Every word onset should be one of sherpa's token onsets, give or take a
  // model frame: int8 dynamic quantisation turns feature differences of
  // ~3e-5 (float rounding between kaldi-native-fbank and JS) into occasional
  // one-frame onset shifts, even between two native onnxruntime runs.
  const onsetDelta = result.words.reduce(
    (worst, word) =>
      Math.max(
        worst,
        Math.min(...expected.timestamps.map((t) => Math.abs(word.start - t))),
      ),
    result.words.length ? 0 : Infinity,
  );
  const ok = textMatches && onsetDelta <= 0.061;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} lang=${result.language} rtf=${(seconds / expected.dur).toFixed(3)} ` +
      `(${seconds.toFixed(2)}s for ${expected.dur.toFixed(1)}s) max onsetΔ=${onsetDelta.toFixed(3)}`,
  );
  console.log(`   js:     ${result.text}`);
  if (!textMatches) console.log(`   sherpa: ${expected.text}`);
}
process.exitCode = failures ? 1 : 0;
