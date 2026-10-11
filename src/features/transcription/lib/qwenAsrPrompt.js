/**
 * Prompt construction and output decoding for Qwen3-ASR-0.6B, following the
 * `prompt_config.json` (layout v2) of the browser ONNX export.
 */

export const QWEN_ASR_TOKENS = Object.freeze({
  endOfText: 151643,
  imStart: 151644,
  imEnd: 151645,
  audioStart: 151669,
  audioEnd: 151670,
  audioPad: 151676,
  asrText: 151704,
  firstSpecial: 151643,
});

/** @type {ReadonlyArray<number>} */
export const QWEN_ASR_EOS_IDS = Object.freeze([
  QWEN_ASR_TOKENS.endOfText,
  QWEN_ASR_TOKENS.imEnd,
]);

// <|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>
const PREFIX_IDS = [151644, 9125, 198, 151645, 198, 151644, 882, 198, 151669];
// <|audio_end|><|im_end|>\n<|im_start|>assistant\n
const SUFFIX_IDS = [151670, 151645, 198, 151644, 77091, 198];

/** "language": the first header token, before the model names a language. */
export const QWEN_ASR_HEADER_KEYWORD_ID = 11528;

/** "language <Name><asr_text>" ids for forced-language decoding. */
export const QWEN_ASR_LANGUAGE_PREFIX_IDS = Object.freeze({
  zh: [11528, 8453, 151704],
  en: [11528, 6364, 151704],
  yue: [11528, 72366, 2367, 151704],
});

/** Phrase repeats at or above this count are a decoding loop, not speech. */
const PHRASE_REPEAT_LIMIT = 6;
/** Single characters may legitimately run long ("哈哈哈", "……"). */
const CHAR_REPEAT_LIMIT = 20;

const CONV_WINDOW = 100;
const TOKENS_PER_WINDOW = 13;

/**
 * Number of encoder output tokens for `frames` mel frames.
 * @param {number} frames
 */
export function qwenAudioTokenCount(frames) {
  const conv = (/** @type {number} */ value) => Math.floor((value + 1) / 2);
  return (
    conv(conv(conv(frames % CONV_WINDOW))) +
    TOKENS_PER_WINDOW * Math.floor(frames / CONV_WINDOW)
  );
}

/**
 * @param {{ audioTokens: number, prefixIds?: ReadonlyArray<number> }} options
 *   `prefixIds` start the assistant turn, e.g. a forced language header
 * @returns {{ ids: number[], audioStart: number }}
 */
export function buildQwenAsrPrompt({ audioTokens, prefixIds = [] }) {
  const ids = [
    ...PREFIX_IDS,
    ...new Array(audioTokens).fill(QWEN_ASR_TOKENS.audioPad),
    ...SUFFIX_IDS,
    ...prefixIds,
  ];
  return { ids, audioStart: PREFIX_IDS.length };
}

/**
 * Byte-level BPE decoder (GPT-2 byte mapping) over `vocab.json`.
 * @param {Record<string, number>} vocab token string -> id
 */
export function createQwenTokenDecoder(vocab) {
  const byteForChar = createUnicodeToByteMap();
  /** @type {Map<number, Uint8Array>} */
  const bytesById = new Map();
  for (const [token, id] of Object.entries(vocab)) {
    const bytes = new Uint8Array(token.length);
    let length = 0;
    for (const char of token) {
      const byte = byteForChar.get(char);
      if (byte !== undefined) bytes[length++] = byte;
    }
    bytesById.set(id, bytes.slice(0, length));
  }
  const textDecoder = new TextDecoder("utf-8");

  return {
    /**
     * @param {ArrayLike<number>} ids
     * @returns {string}
     */
    decode(ids) {
      const parts = [];
      let total = 0;
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        if (id >= QWEN_ASR_TOKENS.firstSpecial) continue;
        const bytes = bytesById.get(id);
        if (!bytes) continue;
        parts.push(bytes);
        total += bytes.length;
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const bytes of parts) {
        joined.set(bytes, offset);
        offset += bytes.length;
      }
      return textDecoder.decode(joined);
    },
  };
}

/**
 * Split generated ids into the detected language and the transcript.
 * @param {ArrayLike<number>} ids generated ids (prompt excluded)
 * @param {{ decode: (ids: ArrayLike<number>) => string }} decoder
 * @returns {{ language: string | null, text: string, hasHeader: boolean }}
 */
export function parseQwenAsrOutput(ids, decoder) {
  const list = Array.from(ids);
  const marker = list.indexOf(QWEN_ASR_TOKENS.asrText);
  if (marker < 0) {
    return {
      language: null,
      text: collapseRepeatedText(decoder.decode(list).trim()),
      hasHeader: false,
    };
  }
  const header = decoder.decode(list.slice(0, marker)).trim();
  const language = header.replace(/^language\s*/i, "").trim() || null;
  // "language None" is the model's own no-speech verdict; text after it is
  // a hallucination on silence or noise.
  if (language?.toLowerCase() === "none")
    return { language: null, text: "", hasHeader: true };
  return {
    language,
    text: collapseRepeatedText(decoder.decode(list.slice(marker + 1)).trim()),
    hasHeader: true,
  };
}

/**
 * Keep one copy of runaway repeats, after the official `qwen_asr`
 * `detect_and_fix_repetitions` but with a lower phrase limit: real speech
 * rarely repeats a phrase six times in a row.
 * @param {string} text
 */
export function collapseRepeatedText(text) {
  const chars = text.replace(
    new RegExp(`(.)\\1{${CHAR_REPEAT_LIMIT},}`, "gsu"),
    "$1",
  );
  return chars.replace(
    new RegExp(`(.{2,40}?)(?:\\s*\\1){${PHRASE_REPEAT_LIMIT - 1},}`, "gsu"),
    (match, unit) => (/^(.)\1*$/su.test(unit) ? match : unit),
  );
}

/** Inverse of GPT-2's `bytes_to_unicode`. */
function createUnicodeToByteMap() {
  /** @type {number[]} */
  const printable = [];
  for (let byte = 33; byte <= 126; byte += 1) printable.push(byte);
  for (let byte = 161; byte <= 172; byte += 1) printable.push(byte);
  for (let byte = 174; byte <= 255; byte += 1) printable.push(byte);
  const map = new Map();
  for (const byte of printable) map.set(String.fromCharCode(byte), byte);
  let extra = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    if (printable.includes(byte)) continue;
    map.set(String.fromCharCode(256 + extra), byte);
    extra += 1;
  }
  return map;
}
