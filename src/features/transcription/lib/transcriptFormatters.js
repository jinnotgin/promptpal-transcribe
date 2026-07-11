/**
 * @typedef {import('./transcriptionDb.js').TranscriptSegment} TranscriptSegment
 */

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  const safe = Math.max(0, seconds || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatSrtTimestamp(seconds) {
  const safe = Math.max(0, seconds || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/**
 * @param {TranscriptSegment[]} segments
 * @returns {string}
 */
export function formatPlainText(segments) {
  return segments
    .map((segment) => {
      const speaker = segment.speaker ? ` ${segment.speaker}` : "";
      return `[${formatClock(segment.start)}${speaker}] ${segment.text.trim()}`;
    })
    .join("\n\n");
}

/**
 * @param {TranscriptSegment[]} segments
 * @returns {string}
 */
export function formatMarkdown(segments) {
  return segments
    .map((segment) => {
      const speaker = segment.speaker ? ` ${segment.speaker}` : "";
      return `**[${formatClock(segment.start)}${speaker}]** ${segment.text.trim()}`;
    })
    .join("\n\n");
}

/**
 * @param {TranscriptSegment[]} segments
 * @returns {string}
 */
export function formatSrt(segments) {
  return segments
    .map((segment, index) => {
      const speaker = segment.speaker ? `${segment.speaker}: ` : "";
      return [
        String(index + 1),
        `${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}`,
        `${speaker}${segment.text.trim()}`,
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * @param {string} fileName
 * @returns {string}
 */
export function transcriptBaseName(fileName) {
  const name = fileName || "transcript";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
