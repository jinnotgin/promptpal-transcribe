/**
 * IEEE 754 half-precision conversion for fp16 ONNX tensors, which
 * onnxruntime-web exchanges as raw Uint16Array bits.
 */

const floatView = new Float32Array(1);
const intView = new Uint32Array(floatView.buffer);

/**
 * @param {ArrayLike<number>} values
 * @returns {Uint16Array}
 */
export function float32ToFloat16Bits(values) {
  const out = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    floatView[0] = values[index];
    const bits = intView[0];
    const sign = (bits >>> 16) & 0x8000;
    const exponent = (bits >>> 23) & 0xff;
    let mantissa = bits & 0x7fffff;

    if (exponent === 0xff) {
      out[index] = sign | 0x7c00 | (mantissa ? 0x200 : 0);
      continue;
    }
    const halfExponent = exponent - 127 + 15;
    if (halfExponent >= 0x1f) {
      out[index] = sign | 0x7c00;
      continue;
    }
    if (halfExponent <= 0) {
      if (halfExponent < -10) {
        out[index] = sign;
        continue;
      }
      mantissa |= 0x800000;
      const shift = 14 - halfExponent;
      let half = mantissa >>> shift;
      const remainder = mantissa & ((1 << shift) - 1);
      const halfway = 1 << (shift - 1);
      if (remainder > halfway || (remainder === halfway && half & 1)) half += 1;
      out[index] = sign | half;
      continue;
    }
    let half = (halfExponent << 10) | (mantissa >>> 13);
    const remainder = mantissa & 0x1fff;
    if (remainder > 0x1000 || (remainder === 0x1000 && half & 1)) half += 1;
    out[index] = sign | half;
  }
  return out;
}

/**
 * @param {ArrayLike<number>} bits
 * @returns {Float32Array}
 */
export function float16BitsToFloat32(bits) {
  const out = new Float32Array(bits.length);
  for (let index = 0; index < bits.length; index += 1) {
    const half = bits[index];
    const sign = half & 0x8000 ? -1 : 1;
    const exponent = (half >>> 10) & 0x1f;
    const mantissa = half & 0x3ff;
    if (exponent === 0) {
      out[index] = sign * mantissa * 2 ** -24;
    } else if (exponent === 0x1f) {
      out[index] = mantissa ? Number.NaN : sign * Infinity;
    } else {
      out[index] = sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
    }
  }
  return out;
}

/**
 * Data for an fp16 tensor: a Float16Array where the platform has one (newer
 * onnxruntime-web reads a Uint16Array there as numbers, not bits), else raw
 * bits in a Uint16Array.
 * @param {ArrayLike<number>} values
 * @returns {Uint16Array}
 */
export function float32ToFloat16Data(values) {
  const Float16 = /** @type {any} */ (globalThis).Float16Array;
  return Float16 ? new Float16(values) : float32ToFloat16Bits(values);
}

/**
 * fp16 tensor data as float32. onnxruntime-web returns raw bits in a
 * Uint16Array, or real values in a Float16Array where the platform has one.
 * @param {ArrayLike<number>} data
 * @returns {Float32Array}
 */
export function float16DataToFloat32(data) {
  return data instanceof Uint16Array
    ? float16BitsToFloat32(data)
    : Float32Array.from(data);
}
