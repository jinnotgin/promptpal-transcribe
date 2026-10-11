import { describe, expect, it } from "vitest";
import {
  dominantSpeakerTurns,
  probabilitiesToSpeakerSegments,
  segmentsToProbabilities,
} from "./diarizationTurns.js";

/**
 * Build [frames, speakers] probabilities from per-speaker active ranges given
 * in frames (10 ms each).
 * @param {number} frames
 * @param {number} numSpeakers
 * @param {Array<[number, number, number]>} ranges [speaker, startFrame, endFrame)
 */
function makeProbs(frames, numSpeakers, ranges) {
  const probs = new Float32Array(frames * numSpeakers).fill(0.05);
  for (const [speaker, start, end] of ranges) {
    for (let frame = start; frame < end; frame += 1) {
      probs[frame * numSpeakers + speaker] = 0.9;
    }
  }
  return { probs, frames, numSpeakers, frameSeconds: 0.01 };
}

describe("probabilitiesToSpeakerSegments", () => {
  it("thresholds each speaker channel into 1-based labelled segments", () => {
    const segments = probabilitiesToSpeakerSegments(
      makeProbs(600, 3, [
        [0, 0, 200],
        [1, 180, 400],
        [0, 420, 600],
      ]),
    );
    expect(segments).toEqual([
      { id: 1, start: 0, end: 2 },
      { id: 2, start: 1.8, end: 4 },
      { id: 1, start: 4.2, end: 6 },
    ]);
  });

  it("bridges short gaps and drops blips", () => {
    const segments = probabilitiesToSpeakerSegments(
      makeProbs(500, 2, [
        [0, 0, 100],
        [0, 110, 200],
        [1, 300, 305],
      ]),
    );
    expect(segments).toEqual([{ id: 1, start: 0, end: 2 }]);
  });

  it("renumbers speakers compactly by first appearance", () => {
    const segments = probabilitiesToSpeakerSegments(
      makeProbs(400, 8, [
        [5, 0, 100],
        [2, 150, 250],
        [7, 300, 400],
      ]),
    );
    expect(segments.map((segment) => segment.id)).toEqual([1, 2, 3]);
  });
});

describe("dominantSpeakerTurns", () => {
  it("splits overlapping speech at the most probable speaker", () => {
    const input = makeProbs(500, 2, [
      [0, 0, 260],
      [1, 240, 500],
    ]);
    // Speaker 1 dominates the overlap.
    for (let frame = 240; frame < 260; frame += 1)
      input.probs[frame * 2 + 1] = 0.95;
    expect(dominantSpeakerTurns(input)).toEqual([
      { id: 1, start: 0, end: 2.4 },
      { id: 2, start: 2.4, end: 5 },
    ]);
  });

  it("absorbs very short turns into the surrounding speaker", () => {
    const turns = dominantSpeakerTurns(
      makeProbs(600, 2, [
        [0, 0, 300],
        [1, 300, 315],
        [0, 315, 600],
      ]),
    );
    expect(turns).toEqual([{ id: 1, start: 0, end: 6 }]);
  });
});

describe("segmentsToProbabilities", () => {
  it("rasterises speaker segments into a 10 ms activity grid", () => {
    const grid = segmentsToProbabilities([
      { start: 0, end: 0.05, speaker: 1 },
      { start: 0.03, end: 0.08, speaker: 0 },
    ]);
    expect(grid).toMatchObject({
      frames: 8,
      numSpeakers: 2,
      frameSeconds: 0.01,
    });
    const active = (/** @type {number} */ speaker) =>
      Array.from(
        { length: grid.frames },
        (_, frame) => grid.probs[frame * 2 + speaker],
      );
    expect(active(1)).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
    expect(active(0)).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it("feeds dominant turns for diarize-first ASR", () => {
    const turns = dominantSpeakerTurns(
      segmentsToProbabilities([
        { start: 0.5, end: 4, speaker: 3 },
        { start: 4.2, end: 9, speaker: 0 },
      ]),
    );
    expect(turns).toEqual([
      { id: 1, start: 0.5, end: 4 },
      { id: 2, start: 4.2, end: 9 },
    ]);
  });

  it("returns an empty grid for no segments", () => {
    expect(segmentsToProbabilities([])).toMatchObject({
      frames: 0,
      numSpeakers: 1,
    });
  });
});
