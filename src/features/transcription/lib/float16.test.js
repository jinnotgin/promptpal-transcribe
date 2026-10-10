import { describe, expect, it } from "vitest";
import {
  float16BitsToFloat32,
  float16DataToFloat32,
  float32ToFloat16Bits,
  float32ToFloat16Data,
} from "./float16.js";

describe("float16 conversion", () => {
  it.each([
    0, 1, -2.5, 0.333251953125, 65504, -0.0001220703125, 6.103515625e-5,
  ])("round-trips %f", (value) => {
    const bits = float32ToFloat16Bits(Float32Array.of(value));
    expect(float16BitsToFloat32(bits)[0]).toBeCloseTo(value, 3);
  });

  it("saturates out-of-range values to infinity and keeps NaN", () => {
    const back = float16BitsToFloat32(
      float32ToFloat16Bits(Float32Array.of(1e6, -1e6, Number.NaN)),
    );
    expect(back[0]).toBe(Infinity);
    expect(back[1]).toBe(-Infinity);
    expect(Number.isNaN(back[2])).toBe(true);
  });

  it("rounds to nearest even", () => {
    // 1 + 2^-11 is exactly halfway between two halves; ties go to even (1).
    const bits = float32ToFloat16Bits(Float32Array.of(1 + 2 ** -11));
    expect(bits[0]).toBe(0x3c00);
  });

  it("builds fp16 tensor data that round-trips through the reader", () => {
    const data = float32ToFloat16Data(Float32Array.of(0.5, -3));
    expect(Array.from(float16DataToFloat32(data))).toEqual([0.5, -3]);
  });

  it("reads fp16 tensor data given as raw bits or as Float16Array values", () => {
    expect(
      Array.from(float16DataToFloat32(Uint16Array.of(0x3c00, 0xc000))),
    ).toEqual([1, -2]);
    const Float16 = /** @type {any} */ (globalThis).Float16Array;
    if (Float16) {
      expect(Array.from(float16DataToFloat32(Float16.of(1.5, -0.25)))).toEqual([
        1.5, -0.25,
      ]);
    }
  });
});
