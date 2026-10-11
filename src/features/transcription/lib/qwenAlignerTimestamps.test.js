import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/qwenAligner.fixture.json";
import {
  alignedUnitTimes,
  repairAlignerTimestamps,
} from "./qwenAlignerTimestamps.js";

describe("repairAlignerTimestamps", () => {
  for (const [index, repair] of fixture.repairs.entries()) {
    it(`matches the reference repair (case ${index})`, () => {
      expect(repairAlignerTimestamps(repair.input)).toEqual(repair.output);
    });
  }

  it("keeps already monotonic timestamps", () => {
    expect(repairAlignerTimestamps([0, 80, 80, 160])).toEqual([0, 80, 80, 160]);
  });

  it("handles an empty list", () => {
    expect(repairAlignerTimestamps([])).toEqual([]);
  });
});

describe("alignedUnitTimes", () => {
  it("pairs start and end slots per unit in seconds from an offset", () => {
    // classes are 80 ms steps
    expect(alignedUnitTimes([1, 3, 3, 5], 2, { offset: 10 })).toEqual([
      { start: 10.08, end: 10.24 },
      { start: 10.24, end: 10.4 },
    ]);
  });
});
