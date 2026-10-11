import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/qwenAligner.fixture.json";
import { createQwenAligner } from "./qwenAligner.js";
import { ALIGNER_TOKENS } from "./qwenAlignerText.js";

const CLASSES = 5000;

/**
 * Fake model: the n-th timestamp slot predicts class `slotClasses[n]`.
 * @param {number[]} slotClasses
 * @param {Array<{ ids: number[], frames: number }>} calls
 */
function fakeModel(slotClasses, calls) {
  return async (
    /** @type {{ inputIds: BigInt64Array, frames: number }} */ input,
  ) => {
    const ids = Array.from(input.inputIds, Number);
    calls.push({ ids, frames: input.frames });
    const logits = new Float32Array(ids.length * CLASSES);
    let slot = 0;
    ids.forEach((id, position) => {
      if (id === ALIGNER_TOKENS.timestamp) {
        logits[position * CLASSES + slotClasses[slot]] = 1;
        slot += 1;
      }
    });
    return { logits, classes: CLASSES };
  };
}

const aligner = (/** @type {any} */ runModel) =>
  createQwenAligner({
    runModel,
    vocab: fixture.vocab,
    merges: /** @type {Array<[number, string]>} */ (fixture.merges),
  });

describe("createQwenAligner", () => {
  it("returns one timing per unit from the timestamp slots", async () => {
    /** @type {Array<{ ids: number[], frames: number }>} */
    const calls = [];
    // 这 个 budget: slots 0-2, 2-5, 6-12 (80 ms each)
    const run = fakeModel([0, 2, 2, 5, 6, 12], calls);
    const pcm = new Float32Array(16000 * 2);
    const times = await aligner(run).align(pcm, "这个 budget", { offset: 30 });
    expect(times).toEqual([
      { start: 30, end: 30.16 },
      { start: 30.16, end: 30.4 },
      { start: 30.48, end: 30.96 },
    ]);
    expect(calls[0].frames).toBe(200);
    // 200 frames -> 26 audio tokens
    expect(
      calls[0].ids.filter((id) => id === ALIGNER_TOKENS.audioPad),
    ).toHaveLength(26);
  });

  it("clamps timings to the end of the clip", async () => {
    const run = fakeModel([10, 400], []);
    const times = await aligner(run).align(new Float32Array(16000), "好", {
      offset: 5,
    });
    expect(times).toEqual([{ start: 5.8, end: 6 }]);
  });

  it("skips text without alignable units", async () => {
    /** @type {Array<{ ids: number[], frames: number }>} */
    const calls = [];
    const result = await aligner(fakeModel([], calls)).align(
      new Float32Array(16000),
      "……！",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
