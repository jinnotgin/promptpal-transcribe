/**
 * Small complex FFT used by the log-mel feature extractors.
 *
 * Power-of-two sizes use an in-place radix-2 transform. Other sizes (Qwen's
 * Whisper-style n_fft=400) use Bluestein's algorithm on a padded radix-2
 * transform, so any frame length is supported without a DFT matrix.
 */

/**
 * @typedef {{ size: number, transform: (re: Float64Array, im: Float64Array) => void }} Fft
 */

/**
 * @param {number} size
 * @returns {Fft}
 */
export function createFft(size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Invalid FFT size: ${size}`);
  }
  return isPowerOfTwo(size) ? createRadix2Fft(size) : createBluesteinFft(size);
}

/**
 * Squared magnitudes of the first n/2+1 bins of a real frame.
 * @param {Fft} fft
 * @param {ArrayLike<number>} frame
 * @param {{ re: Float64Array, im: Float64Array }} [scratch]
 * @returns {Float64Array}
 */
export function powerSpectrum(fft, frame, scratch) {
  const n = fft.size;
  const re = scratch?.re ?? new Float64Array(n);
  const im = scratch?.im ?? new Float64Array(n);
  for (let index = 0; index < n; index += 1) {
    re[index] = frame[index] ?? 0;
    im[index] = 0;
  }
  fft.transform(re, im);
  const bins = Math.floor(n / 2) + 1;
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

/** @param {number} value */
function isPowerOfTwo(value) {
  return (value & (value - 1)) === 0;
}

/**
 * @param {number} size
 * @returns {Fft}
 */
function createRadix2Fft(size) {
  const levels = Math.round(Math.log2(size));
  const reverse = new Uint32Array(size);
  for (let index = 0; index < size; index += 1) {
    let reversed = 0;
    for (let bit = 0; bit < levels; bit += 1) {
      reversed = (reversed << 1) | ((index >>> bit) & 1);
    }
    reverse[index] = reversed;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let index = 0; index < size / 2; index += 1) {
    cos[index] = Math.cos((2 * Math.PI * index) / size);
    sin[index] = -Math.sin((2 * Math.PI * index) / size);
  }

  return {
    size,
    transform(re, im) {
      for (let index = 0; index < size; index += 1) {
        const target = reverse[index];
        if (target > index) {
          const tempRe = re[index];
          re[index] = re[target];
          re[target] = tempRe;
          const tempIm = im[index];
          im[index] = im[target];
          im[target] = tempIm;
        }
      }
      for (let half = 1; half < size; half *= 2) {
        const step = size / (half * 2);
        for (let start = 0; start < size; start += half * 2) {
          for (let offset = 0; offset < half; offset += 1) {
            const twiddleRe = cos[offset * step];
            const twiddleIm = sin[offset * step];
            const even = start + offset;
            const odd = even + half;
            const oddRe = re[odd] * twiddleRe - im[odd] * twiddleIm;
            const oddIm = re[odd] * twiddleIm + im[odd] * twiddleRe;
            re[odd] = re[even] - oddRe;
            im[odd] = im[even] - oddIm;
            re[even] += oddRe;
            im[even] += oddIm;
          }
        }
      }
    },
  };
}

/**
 * @param {number} size
 * @returns {Fft}
 */
function createBluesteinFft(size) {
  let padded = 1;
  while (padded < size * 2 - 1) padded *= 2;
  const inner = createRadix2Fft(padded);

  // chirp[k] = exp(-i*pi*k^2/n); k^2 is reduced mod 2n to keep angles exact.
  const chirpRe = new Float64Array(size);
  const chirpIm = new Float64Array(size);
  for (let k = 0; k < size; k += 1) {
    const angle = (Math.PI * ((k * k) % (2 * size))) / size;
    chirpRe[k] = Math.cos(angle);
    chirpIm[k] = -Math.sin(angle);
  }
  const kernelRe = new Float64Array(padded);
  const kernelIm = new Float64Array(padded);
  for (let k = 0; k < size; k += 1) {
    kernelRe[k] = chirpRe[k];
    kernelIm[k] = -chirpIm[k];
    if (k > 0) {
      kernelRe[padded - k] = chirpRe[k];
      kernelIm[padded - k] = -chirpIm[k];
    }
  }
  inner.transform(kernelRe, kernelIm);
  const workRe = new Float64Array(padded);
  const workIm = new Float64Array(padded);

  return {
    size,
    transform(re, im) {
      workRe.fill(0);
      workIm.fill(0);
      for (let k = 0; k < size; k += 1) {
        workRe[k] = re[k] * chirpRe[k] - im[k] * chirpIm[k];
        workIm[k] = re[k] * chirpIm[k] + im[k] * chirpRe[k];
      }
      inner.transform(workRe, workIm);
      for (let k = 0; k < padded; k += 1) {
        const productRe = workRe[k] * kernelRe[k] - workIm[k] * kernelIm[k];
        const productIm = workRe[k] * kernelIm[k] + workIm[k] * kernelRe[k];
        // Inverse via conjugation: ifft(x) = conj(fft(conj(x))) / n.
        workRe[k] = productRe;
        workIm[k] = -productIm;
      }
      inner.transform(workRe, workIm);
      for (let k = 0; k < size; k += 1) {
        const convRe = workRe[k] / padded;
        const convIm = -workIm[k] / padded;
        re[k] = convRe * chirpRe[k] - convIm * chirpIm[k];
        im[k] = convRe * chirpIm[k] + convIm * chirpRe[k];
      }
    },
  };
}
