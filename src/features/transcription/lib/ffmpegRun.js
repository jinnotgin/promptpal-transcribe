/**
 * Helpers that turn silent FFmpeg WASM failures into readable errors.
 * `ffmpeg.exec()` and `ffmpeg.ffprobe()` resolve with a non-zero exit code
 * instead of throwing, so callers must check it before reading output files.
 */

const REPORTED_LOG_LINES = 3;

/**
 * Rolling buffer of recent FFmpeg log lines.
 * @param {number} [limit]
 */
export function createFfmpegLogTail(limit = 20) {
  /** @type {string[]} */
  let entries = [];
  return {
    /** @param {string} message */
    push(message) {
      const line = String(message ?? "").trim();
      if (!line) return;
      entries.push(line);
      if (entries.length > limit) entries = entries.slice(-limit);
    },
    lines() {
      return [...entries];
    },
    clear() {
      entries = [];
    },
  };
}

/**
 * Run one FFmpeg command and throw a descriptive error on a non-zero exit.
 * @param {string} stage
 * @param {ReturnType<typeof createFfmpegLogTail>} logTail
 * @param {() => Promise<number>} run
 */
export async function runFfmpegStep(stage, logTail, run) {
  logTail.clear();
  const exitCode = await run();
  if (exitCode === 0) return;
  const detail = logTail.lines().slice(-REPORTED_LOG_LINES).join(" | ");
  const summary = `${stage} failed (FFmpeg exit ${exitCode})`;
  throw new Error(detail ? `${summary}: ${detail}` : summary);
}
