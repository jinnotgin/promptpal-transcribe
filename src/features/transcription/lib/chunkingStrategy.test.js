import { describe, expect, it } from "vitest";
import {
  UTTERANCE_CHUNK_LIMITS,
  splitIntoUtteranceChunks,
} from "./chunkingStrategy.js";

const SAMPLE_RATE = 16000;

/**
 * Loud noise everywhere except the given quiet spans.
 * @param {number} seconds
 * @param {Array<[number, number]>} [quiet]
 */
function audio(seconds, quiet = []) {
  const pcm = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < pcm.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const silent = quiet.some(([start, end]) => t >= start && t < end);
    pcm[i] = silent ? 0 : 0.3 * Math.sin(i * 0.37);
  }
  return pcm;
}

/** @param {Array<{ start: number, end: number }>} chunks */
const spans = (chunks) =>
  chunks.map((chunk) => [
    Math.round(chunk.start * 100) / 100,
    Math.round(chunk.end * 100) / 100,
  ]);

describe("splitIntoUtteranceChunks", () => {
  it("pads speech and groups nearby utterances up to the target length", () => {
    const chunks = splitIntoUtteranceChunks(
      [
        { start: 1, end: 3 },
        { start: 3.5, end: 6 },
        { start: 6.4, end: 9.5 },
        { start: 12, end: 13 },
      ],
      audio(20),
    );
    // 1-6 fits the 8 s target; adding 6.4-9.5 would not. 12 s is past the
    // 1 s gap limit, so it starts its own chunk. Padding stops at neighbours.
    expect(spans(chunks)).toEqual([
      [0.8, 6.2],
      [6.2, 9.7],
      [11.8, 13.2],
    ]);
    expect(chunks.map((chunk) => chunk.regionIndex)).toEqual([0, 1, 2]);
  });

  it("splits continuous speech at the quietest point within the cap", () => {
    const chunks = splitIntoUtteranceChunks(
      [{ start: 0, end: 30 }],
      audio(30, [
        [9.5, 9.6],
        [20.1, 20.2],
      ]),
    );
    expect(spans(chunks)).toEqual([
      [0, 9.55],
      [9.55, 20.15],
      [20.15, 30],
    ]);
    for (const chunk of chunks) {
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(
        UTTERANCE_CHUNK_LIMITS.maxDuration,
      );
    }
  });

  it("never exceeds the cap when speech has no quiet point", () => {
    const chunks = splitIntoUtteranceChunks([{ start: 0, end: 40 }], audio(40));
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks[0].start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(40);
    for (let i = 0; i < chunks.length; i += 1) {
      expect(chunks[i].end - chunks[i].start).toBeLessThanOrEqual(
        UTTERANCE_CHUNK_LIMITS.maxDuration,
      );
      if (i > 0) expect(chunks[i].start).toBe(chunks[i - 1].end);
    }
  });

  it("clips padding to the audio and drops empty regions", () => {
    const chunks = splitIntoUtteranceChunks(
      [
        { start: 0.05, end: 0.9 },
        { start: 2, end: 2 },
        { start: 4.9, end: 5.2 },
      ],
      audio(5),
    );
    expect(spans(chunks)).toEqual([
      [0, 1.1],
      [4.7, 5],
    ]);
  });
});
