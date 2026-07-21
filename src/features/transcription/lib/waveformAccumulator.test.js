import { describe, expect, it } from "vitest";
import { createWaveformAccumulator } from "./waveformAccumulator.js";

describe("createWaveformAccumulator", () => {
  it("combines committed samples from overlapping windows without double counting", () => {
    const accumulator = createWaveformAccumulator({
      duration: 4,
      sampleRate: 2,
      barCount: 4,
    });

    accumulator.addWindow(new Float32Array([0.5, 0.5, 1, 1]), {
      readStart: 0,
      commitStart: 0,
      commitEnd: 2,
    });
    accumulator.addWindow(new Float32Array([1, 1, 0.25, 0.25, 0, 0]), {
      readStart: 1,
      commitStart: 2,
      commitEnd: 4,
    });

    expect(accumulator.finalize()).toEqual([0.5, 1, 0.25, 0]);
  });

  it("returns compact finite normalized bars for silent or sparse input", () => {
    const accumulator = createWaveformAccumulator({
      duration: 10,
      sampleRate: 4,
      barCount: 5,
    });
    accumulator.addWindow(new Float32Array(8), {
      readStart: 0,
      commitStart: 0,
      commitEnd: 2,
    });

    const samples = accumulator.finalize();
    expect(samples).toHaveLength(5);
    expect(
      samples.every(
        (sample) => Number.isFinite(sample) && sample >= 0 && sample <= 1,
      ),
    ).toBe(true);
  });
});
