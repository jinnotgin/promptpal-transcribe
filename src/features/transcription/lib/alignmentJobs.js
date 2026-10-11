/**
 * Bookkeeping for the Chinese word-alignment pass: each Qwen3-ASR region
 * becomes a job holding its text and rows, and aligned segments replace the
 * region's proportionally timed rows.
 */

import { joinTranscriptText } from "./qwenAsrSegments.js";

/**
 * @typedef {import('./transcriptionDb.js').TranscriptSegment} TranscriptSegment
 * @typedef {{ start: number, end: number, speaker: string | null, text: string, rowIds: string[] }} AlignmentJob
 */

/**
 * @param {{ start: number, end: number }} region absolute seconds
 * @param {TranscriptSegment[]} rows the region's ASR rows
 * @returns {AlignmentJob | null}
 */
export function alignmentJobForRegion(region, rows) {
  const text = joinTranscriptText(rows.map((row) => row.text.trim()));
  if (!rows.length || !text) return null;
  return {
    start: region.start,
    end: region.end,
    speaker: rows[0].speaker ?? null,
    text,
    rowIds: rows.map((row) => row.id),
  };
}

/**
 * Swap each aligned job's rows for its aligned segments; jobs without a
 * result keep their original rows.
 * @param {TranscriptSegment[]} rows
 * @param {Array<{ job: AlignmentJob, segments: Omit<TranscriptSegment, 'id'>[] }>} aligned
 * @param {() => string} createId
 * @returns {TranscriptSegment[]}
 */
export function replaceAlignedRows(rows, aligned, createId) {
  const replaced = new Set(aligned.flatMap(({ job }) => job.rowIds));
  const next = rows.filter((row) => !replaced.has(row.id));
  for (const { segments } of aligned) {
    for (const segment of segments) next.push({ ...segment, id: createId() });
  }
  return next.sort((a, b) => a.start - b.start);
}

/**
 * Jobs that start inside a window's committed range, in time order.
 * @param {AlignmentJob[]} jobs
 * @param {number} commitStart absolute seconds
 * @param {number} commitEnd absolute seconds
 */
export function jobsInWindow(jobs, commitStart, commitEnd) {
  return jobs
    .filter((job) => job.start >= commitStart && job.start < commitEnd)
    .sort((a, b) => a.start - b.start);
}
