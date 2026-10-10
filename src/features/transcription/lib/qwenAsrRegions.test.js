import { describe, expect, it } from "vitest";
import { planQwenRegions } from "./qwenAsrRegions.js";

const SAMPLE_RATE = 16000;

/**
 * Loud audio with optional quiet gaps (absolute seconds within the window).
 * @param {number} seconds
 * @param {Array<[number, number]>} [quiet]
 */
function makePcm(seconds, quiet = []) {
  const pcm = new Float32Array(seconds * SAMPLE_RATE);
  for (let index = 0; index < pcm.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const isQuiet = quiet.some(([start, end]) => time >= start && time < end);
    pcm[index] = isQuiet ? 0 : 0.3 * Math.sin(index / 7);
  }
  return pcm;
}

const baseWindow = { offset: 0, commitStart: 0, commitEnd: 100 };

describe("planQwenRegions", () => {
  it("pads and merges nearby speech regions", () => {
    const regions = planQwenRegions({
      ...baseWindow,
      pcm: makePcm(100),
      regions: [
        { start: 1, end: 3 },
        { start: 3.3, end: 5 },
        { start: 20, end: 22 },
      ],
    });
    expect(regions).toEqual([
      { start: 0.75, end: 5.25, speakerId: null },
      { start: 19.75, end: 22.25, speakerId: null },
    ]);
  });

  it("cuts regions at speaker changes from diarization turns", () => {
    const regions = planQwenRegions({
      ...baseWindow,
      pcm: makePcm(100),
      regions: [{ start: 2, end: 12 }],
      turns: [
        { id: 1, start: 1.9, end: 6.2 },
        { id: 2, start: 6.2, end: 12.1 },
      ],
    });
    expect(regions).toEqual([
      { start: 1.75, end: 6.2, speakerId: 1 },
      { start: 6.2, end: 12.25, speakerId: 2 },
    ]);
  });

  it("splits long speech near the 30 s limit at the quietest point", () => {
    const regions = planQwenRegions({
      ...baseWindow,
      pcm: makePcm(100, [[27.0, 27.2]]),
      regions: [{ start: 0, end: 50 }],
    });
    expect(regions).toHaveLength(2);
    expect(regions[0].end).toBeGreaterThanOrEqual(27);
    expect(regions[0].end).toBeLessThanOrEqual(27.2);
    expect(regions[1].start).toBe(regions[0].end);
    expect(regions.every((region) => region.end - region.start <= 30)).toBe(
      true,
    );
  });

  it("only keeps audio inside the window's committed range", () => {
    const regions = planQwenRegions({
      pcm: makePcm(40),
      offset: 297,
      commitStart: 300,
      commitEnd: 337,
      regions: [
        { start: 0.5, end: 2.5 },
        { start: 2.8, end: 6 },
      ],
    });
    expect(regions).toEqual([{ start: 300, end: 303.25, speakerId: null }]);
  });

  it("absorbs a short unlabelled gap into the neighbouring turn", () => {
    const regions = planQwenRegions({
      ...baseWindow,
      pcm: makePcm(100),
      regions: [{ start: 2, end: 8 }],
      turns: [{ id: 1, start: 2.5, end: 8 }],
    });
    expect(regions).toEqual([{ start: 1.75, end: 8.25, speakerId: 1 }]);
  });
});
