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
