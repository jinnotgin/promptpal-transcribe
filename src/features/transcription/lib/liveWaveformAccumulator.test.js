import { describe, expect, it } from "vitest";
import { createLiveWaveformAccumulator } from "./liveWaveformAccumulator.js";

describe("createLiveWaveformAccumulator", () => {
  it("keeps bounded rolling state while producing a normalized fixed envelope", () => {
    const accumulator = createLiveWaveformAccumulator({
      sampleRate: 4,
      barCount: 4,
    });
    for (let index = 0; index < 100; index += 1) {
      accumulator.addChunk(new Float32Array([0.25, 0.5, 0.75, 1]));
    }

    expect(accumulator.bucketCount).toBeLessThanOrEqual(8);
    const result = accumulator.finalize();
    expect(result).toHaveLength(4);
    expect(Math.max(...result)).toBe(1);
  });
});
