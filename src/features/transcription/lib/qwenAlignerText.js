/**
 * Text side of Qwen3-ForcedAligner (qwen-asr 0.0.6, Apache-2.0).
 *
 * The transcript is split into alignment units the way
 * `Qwen3ForceAlignProcessor.tokenize_space_lang` does: whitespace-separated
 * pieces keep only letters, digits and apostrophes, and each CJK ideograph
 * becomes its own unit. Each unit is followed by two `<timestamp>` slots
 * whose predicted classes give its start and end.
 */

export const ALIGNER_TOKENS = Object.freeze({
  audioStart: 151669,
  audioEnd: 151670,
  audioPad: 151676,
  timestamp: 151705,
});

/** Qwen2 pre-tokenizer pattern; `(?i:...)` contractions spelled out. */
const PRE_TOKENIZE =
  /'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const KEPT = /[\p{L}\p{N}']/u;

/**
 * @typedef {{ text: string, start: number, end: number }} AlignerUnit
 *   `start`/`end` are UTF-16 offsets of the unit's first and last kept
 *   characters in the source text (end exclusive)
 */

/**
 * @param {string} text
 * @returns {AlignerUnit[]}
 */
export function splitAlignerUnits(text) {
  /** @type {AlignerUnit[]} */
  const units = [];
  /** @type {AlignerUnit | null} */
  let latin = null;
  const flush = () => {
    if (latin) units.push(latin);
    latin = null;
  };
  let offset = 0;
  for (const char of text) {
    const start = offset;
    offset += char.length;
    if (/\s/u.test(char)) {
      flush();
    } else if (isCjk(char)) {
      flush();
      units.push({ text: char, start, end: offset });
    } else if (KEPT.test(char)) {
      if (latin) {
        latin.text += char;
        latin.end = offset;
      } else latin = { text: char, start, end: offset };
    }
  }
  flush();
  return units;
}

/** @param {string} char a single code point */
export function isCjk(char) {
  const code = /** @type {number} */ (char.codePointAt(0));
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * Prompt ids: `<|audio_start|>`, one pad per encoder token, `<|audio_end|>`,
 * then each unit's ids followed by two timestamp slots.
 * @param {{ audioTokens: number, units: number[][] }} options
 * @returns {{ ids: number[], timestampPositions: number[] }}
 */
export function buildAlignerPrompt({ audioTokens, units }) {
  /** @type {number[]} */
  const ids = [ALIGNER_TOKENS.audioStart];
  for (let i = 0; i < audioTokens; i += 1) ids.push(ALIGNER_TOKENS.audioPad);
  ids.push(ALIGNER_TOKENS.audioEnd);
  /** @type {number[]} */
  const timestampPositions = [];
  for (const unitIds of units) {
    ids.push(...unitIds);
    timestampPositions.push(ids.length, ids.length + 1);
    ids.push(ALIGNER_TOKENS.timestamp, ALIGNER_TOKENS.timestamp);
  }
  return { ids, timestampPositions };
}

/**
 * @param {string} text contents of `merges.txt`
 * @returns {Array<[number, string]>} [rank, "left right"]
 */
export function parseMerges(text) {
  /** @type {Array<[number, string]>} */
  const merges = [];
  for (const line of text.split("\n")) {
    const merge = line.replace(/\r$/, "");
    if (!merge || merge.startsWith("#")) continue;
    merges.push([merges.length, merge]);
  }
  return merges;
}

/**
 * Byte-level BPE encoder for single alignment units (no special tokens).
 * @param {{ vocab: Record<string, number>, merges: Iterable<[number, string]> }} options
 */
export function createQwenBpeEncoder({ vocab, merges }) {
  /** @type {Map<string, number>} */
  const ranks = new Map();
  for (const [rank, merge] of merges) ranks.set(merge, rank);
  const charForByte = bytesToUnicode();
  const utf8 = new TextEncoder();
  /** @type {Map<string, number[]>} */
  const cache = new Map();

  /** @param {string} piece byte-level mapped */
  function bpe(piece) {
    const symbols = Array.from(piece);
    while (symbols.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < symbols.length - 1; i += 1) {
        const rank = ranks.get(`${symbols[i]} ${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = i;
        }
      }
      if (best < 0) break;
      symbols.splice(best, 2, symbols[best] + symbols[best + 1]);
    }
    return symbols;
  }

  return {
    /**
     * @param {string} text
     * @returns {number[]}
     */
    encode(text) {
      const cached = cache.get(text);
      if (cached) return cached;
      /** @type {number[]} */
      const ids = [];
      for (const match of text.normalize("NFC").matchAll(PRE_TOKENIZE)) {
        let mapped = "";
        for (const byte of utf8.encode(match[0])) mapped += charForByte[byte];
        for (const symbol of bpe(mapped)) {
          const id = vocab[symbol];
          if (id === undefined) throw new Error(`Unknown BPE token: ${symbol}`);
          ids.push(id);
        }
      }
      cache.set(text, ids);
      return ids;
    },
  };
}

/** GPT-2's `bytes_to_unicode`. */
function bytesToUnicode() {
  /** @type {string[]} */
  const table = new Array(256);
  let extra = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    const printable =
      (byte >= 33 && byte <= 126) ||
      (byte >= 161 && byte <= 172) ||
      (byte >= 174 && byte <= 255);
    table[byte] = String.fromCharCode(printable ? byte : 256 + extra++);
  }
  return table;
}
