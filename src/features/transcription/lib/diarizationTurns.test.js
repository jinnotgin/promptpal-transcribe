import { describe, expect, it } from "vitest";
import {
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

  it("returns an empty grid for no segments", () => {
    expect(segmentsToProbabilities([])).toMatchObject({
      frames: 0,
      numSpeakers: 1,
    });
  });
});
