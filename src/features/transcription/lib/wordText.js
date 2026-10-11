/**
 * Joining recognised words back into display text. Chinese and Japanese are
 * written without spaces, so ASR words in those scripts (one character each
 * from SenseVoice) join directly, while Latin words, including English inside
 * Chinese speech, keep their spaces.
 */

const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LEADING_PUNCTUATION = /^[\p{P}]/u;

/**
 * @param {string} char
 */
export function isUnspacedScript(char) {
  return UNSPACED_SCRIPT.test(char);
}

/**
 * @param {string[]} texts
 */
export function joinWordTexts(texts) {
  let joined = "";
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (joined && needsSpace(joined, text)) joined += " ";
    joined += text;
  }
  return joined;
}

/**
 * @param {string} before
 * @param {string} next
 */
function needsSpace(before, next) {
  if (LEADING_PUNCTUATION.test(next)) return false;
  const last = Array.from(before).at(-1) ?? "";
  const first = Array.from(next)[0] ?? "";
  return !isUnspacedScript(last) && !isUnspacedScript(first);
}

const SENTENCE_END = /[.!?。！？]["'”’」』)]?$/u;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;

/**
 * @param {string} text
 */
export function endsSentence(text) {
  return SENTENCE_END.test(text.trim());
}

/**
 * Splits display text into words for rows that carry no word timings:
 * whitespace-separated runs, with Chinese and Japanese characters as one word
 * each and punctuation attached to the word before it.
 * @param {string} text
 * @returns {string[]}
 */
export function splitTextIntoWords(text) {
  /** @type {string[]} */
  const words = [];
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    let latinRun = "";
    const flush = () => {
      if (latinRun) words.push(latinRun);
      latinRun = "";
    };
    for (const char of token) {
      if (isUnspacedScript(char)) {
        flush();
        words.push(char);
      } else if (PUNCTUATION.test(char) && !latinRun && words.length) {
        words[words.length - 1] += char;
      } else {
        latinRun += char;
      }
    }
    flush();
  }
  return words;
}
