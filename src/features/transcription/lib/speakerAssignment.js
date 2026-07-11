/**
 * @typedef {import('./transcriptionDb.js').TranscriptSegment} TranscriptSegment
 * @typedef {{ segmentId: string, speaker: string }} SpeakerAssignment
 */

/**
 * Apply speaker assignments to transcript segments.
 * @param {TranscriptSegment[]} segments
 * @param {SpeakerAssignment[]} assignments
 * @returns {TranscriptSegment[]}
 */
export function assignSpeakersToSegments(segments, assignments) {
  const speakerBySegmentId = new Map(
    assignments.map((assignment) => [assignment.segmentId, assignment.speaker]),
  );

  return segments.map((segment) => ({
    ...segment,
    speaker: speakerBySegmentId.get(segment.id) ?? segment.speaker,
  }));
}
