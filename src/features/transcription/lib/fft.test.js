import { describe, expect, it } from "vitest";
import { createFft, powerSpectrum } from "./fft.js";

/**
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
function naiveDft(re, im) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(angle) - im[t] * Math.sin(angle);
      outIm[k] += re[t] * Math.sin(angle) + im[t] * Math.cos(angle);
    }
  }
  return { re: outRe, im: outIm };
}

function randomSignal(n, seed) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let index = 0; index < n; index += 1) {
    re[index] = next();
    im[index] = next();
  }
  return { re, im };
}

describe("createFft", () => {
  it.each([8, 512, 400, 6, 1])("matches a naive DFT for n=%i", (n) => {
    const signal = randomSignal(n, n + 3);
    const expected = naiveDft(signal.re, signal.im);
    const fft = createFft(n);
    const re = Float64Array.from(signal.re);
    const im = Float64Array.from(signal.im);
    fft.transform(re, im);
    for (let k = 0; k < n; k += 1) {
      expect(re[k]).toBeCloseTo(expected.re[k], 9);
      expect(im[k]).toBeCloseTo(expected.im[k], 9);
    }
  });
});

describe("powerSpectrum", () => {
  it("returns n/2+1 squared magnitudes of a real frame", () => {
    const n = 400;
    const frame = new Float64Array(n);
    for (let t = 0; t < n; t += 1)
      frame[t] = Math.cos((2 * Math.PI * 25 * t) / n);
    const power = powerSpectrum(createFft(n), frame);
    expect(power).toHaveLength(n / 2 + 1);
    expect(power[25]).toBeCloseTo((n / 2) ** 2, 6);
    expect(power[24]).toBeCloseTo(0, 6);
  });
});
