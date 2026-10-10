/**
 * Arrival-Order Speaker Cache + FIFO queue for Nemotron 3 Diarization.
 *
 * A port of `Nemotron3DiarizationSpeakerCache` from transformers (Apache-2.0).
 * Every streaming step attends to the cached frames returned by `getEmbeds`;
 * `update` pushes the step's chunk into the FIFO and, once it overflows, moves
 * the oldest frames into the speaker cache, compressing it to the most
 * informative frames per speaker when it is full.
 */

/**
 * @typedef {{
 *   numSpeakers: number,
 *   hiddenSize: number,
 *   subsamplingFactor: number,
 *   speakerCacheLength: number,
 *   fifoLength: number,
 *   speakerCacheUpdatePeriod: number,
 *   silenceFramesPerSpeaker: number,
 *   predictionScoreThreshold: number,
 *   latestFramesScoreBoost: number,
 *   minPositiveScoresRate: number,
 *   strongBoostRate: number,
 *   weakBoostRate: number,
 * }} NemotronSpeakerCacheConfig
 */

/** Offline (30.4 s chunk) settings from nvidia/Nemotron-3-Diarization config.json. */
export const NEMOTRON_OFFLINE_CACHE_CONFIG = Object.freeze({
  numSpeakers: 8,
  hiddenSize: 512,
  subsamplingFactor: 8,
  speakerCacheLength: 264,
  fifoLength: 40,
  speakerCacheUpdatePeriod: 300,
  silenceFramesPerSpeaker: 1,
  predictionScoreThreshold: 0.25,
  latestFramesScoreBoost: 0.05,
  minPositiveScoresRate: 0.5,
  strongBoostRate: 0.75,
  weakBoostRate: 1.5,
});

const LOG_HALF = Math.log(0.5);

export class NemotronSpeakerCache {
  /** @param {NemotronSpeakerCacheConfig} config */
  constructor(config) {
    this.config = config;
    const budget =
      Math.floor(config.speakerCacheLength / config.numSpeakers) -
      config.silenceFramesPerSpeaker;
    this.minPositiveScores = Math.floor(budget * config.minPositiveScoresRate);
    this.numStrongBoosted = Math.floor(budget * config.strongBoostRate);
    this.numWeakBoosted = Math.floor(budget * config.weakBoostRate);

    const { hiddenSize, numSpeakers, speakerCacheLength } = config;
    this.embeds = new Float32Array(speakerCacheLength * hiddenSize);
    this.probs = new Float32Array(speakerCacheLength * numSpeakers);
    this.fifo = new Float32Array(config.fifoLength * hiddenSize);
    this.numCacheFrames = 0;
    this.numFifoFrames = 0;
    this.isCompressed = false;
  }

  /** Number of frames `getEmbeds` returns (cache + FIFO). */
  get cachedFrameCount() {
    return this.numCacheFrames + this.numFifoFrames;
  }

  /** @returns {Float32Array} [cache frames + FIFO frames, hidden] */
  getEmbeds() {
    const { hiddenSize } = this.config;
    const out = new Float32Array(this.cachedFrameCount * hiddenSize);
    out.set(this.embeds.subarray(0, this.numCacheFrames * hiddenSize));
    out.set(
      this.fifo.subarray(0, this.numFifoFrames * hiddenSize),
      this.numCacheFrames * hiddenSize,
    );
    return out;
  }

  cacheEmbeds() {
    return this.embeds.slice(0, this.numCacheFrames * this.config.hiddenSize);
  }

  cacheProbs() {
    return this.probs.slice(0, this.numCacheFrames * this.config.numSpeakers);
  }

  fifoEmbeds() {
    return this.fifo.slice(0, this.numFifoFrames * this.config.hiddenSize);
  }

  /**
   * @param {{
   *   inputEmbeds: Float32Array,
   *   inputFrames: number,
   *   logits: Float32Array,
   *   silenceEmbeds: Float32Array,
   *   chunkFrames: number,
   *   mask?: Uint8Array | null,
   * }} step
   *   `inputEmbeds` is the encoder input of the step: cached frames, chunk and
   *   look-ahead. `logits` are its speaker logits at the mel frame rate.
   */
  update({
    inputEmbeds,
    inputFrames,
    logits,
    silenceEmbeds,
    chunkFrames,
    mask,
  }) {
    const { hiddenSize, numSpeakers, fifoLength, speakerCacheLength } =
      this.config;
    const numCache = this.numCacheFrames;
    const numFifo = this.numFifoFrames;
    const probs = this.poolProbs(logits, inputFrames, mask ?? null);

    const chunkStart = numCache + numFifo;
    const fifoFrames = numFifo + chunkFrames;
    const fifoEmbeds = new Float32Array(fifoFrames * hiddenSize);
    fifoEmbeds.set(this.fifo.subarray(0, numFifo * hiddenSize));
    fifoEmbeds.set(
      inputEmbeds.subarray(
        chunkStart * hiddenSize,
        (chunkStart + chunkFrames) * hiddenSize,
      ),
      numFifo * hiddenSize,
    );

    const popped = this.numPoppedFrames(fifoFrames);
    let remainingFifo = fifoEmbeds;
    let remainingFrames = fifoFrames;
    if (popped) {
      const mergedFrames = numCache + popped;
      let cacheEmbeds = new Float32Array(mergedFrames * hiddenSize);
      cacheEmbeds.set(this.embeds.subarray(0, numCache * hiddenSize));
      cacheEmbeds.set(
        fifoEmbeds.subarray(0, popped * hiddenSize),
        numCache * hiddenSize,
      );

      // An uncompressed cache still holds plain chunk frames whose
      // probabilities this step re-estimates; a compressed one is out of
      // order, so only the probabilities stored alongside it apply.
      let cacheProbs = new Float32Array(mergedFrames * numSpeakers);
      cacheProbs.set(
        this.isCompressed
          ? this.probs.subarray(0, numCache * numSpeakers)
          : probs.subarray(0, numCache * numSpeakers),
      );
      cacheProbs.set(
        probs.subarray(
          numCache * numSpeakers,
          (numCache + popped) * numSpeakers,
        ),
        numCache * numSpeakers,
      );
      remainingFifo = fifoEmbeds.subarray(popped * hiddenSize);
      remainingFrames = fifoFrames - popped;

      let cacheFrames = mergedFrames;
      if (mergedFrames > speakerCacheLength) {
        ({ embeds: cacheEmbeds, probs: cacheProbs } = this.compress(
          cacheEmbeds,
          cacheProbs,
          mergedFrames,
          silenceEmbeds,
        ));
        cacheFrames = speakerCacheLength;
        this.isCompressed = true;
      }
      this.embeds.set(cacheEmbeds.subarray(0, cacheFrames * hiddenSize));
      this.probs.set(cacheProbs.subarray(0, cacheFrames * numSpeakers));
      this.numCacheFrames = cacheFrames;
    }

    if (remainingFrames > fifoLength) {
      throw new Error(
        "Nemotron FIFO overflow: chunk exceeds cache update period",
      );
    }
    this.fifo.set(remainingFifo.subarray(0, remainingFrames * hiddenSize));
    this.numFifoFrames = remainingFrames;
  }

  /**
   * Speaker probabilities pooled to the encoder frame rate, zeroed on padding.
   * @param {Float32Array} logits [inputFrames * subsampling, speakers]
   * @param {number} inputFrames
   * @param {Uint8Array | null} mask
   */
  poolProbs(logits, inputFrames, mask) {
    const { numSpeakers, subsamplingFactor } = this.config;
    const probs = new Float32Array(inputFrames * numSpeakers);
    for (let frame = 0; frame < inputFrames; frame += 1) {
      if (mask && !mask[frame]) continue;
      for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
        let sum = 0;
        for (let k = 0; k < subsamplingFactor; k += 1) {
          sum += sigmoid(
            logits[(frame * subsamplingFactor + k) * numSpeakers + speaker],
          );
        }
        probs[frame * numSpeakers + speaker] = sum / subsamplingFactor;
      }
    }
    return probs;
  }

  /** @param {number} fifoFrames */
  numPoppedFrames(fifoFrames) {
    const { fifoLength, speakerCacheUpdatePeriod } = this.config;
    if (fifoFrames <= fifoLength) return 0;
    return Math.min(
      Math.max(speakerCacheUpdatePeriod, fifoFrames - fifoLength),
      fifoFrames,
    );
  }

  /**
   * @param {Float32Array} probs [frames, speakers]
   * @param {number} frames
   */
  frameScores(probs, frames) {
    const { numSpeakers, predictionScoreThreshold: threshold } = this.config;
    const scores = new Float64Array(frames * numSpeakers);
    const positives = new Int32Array(numSpeakers);
    for (let frame = 0; frame < frames; frame += 1) {
      let complementSum = 0;
      for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
        complementSum += Math.log(
          Math.max(1 - probs[frame * numSpeakers + speaker], threshold),
        );
      }
      for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
        const index = frame * numSpeakers + speaker;
        const p = probs[index];
        if (!(p > 0.5)) {
          scores[index] = -Infinity;
          continue;
        }
        const score =
          Math.log(Math.max(p, threshold)) -
          Math.log(Math.max(1 - p, threshold)) +
          complementSum -
          LOG_HALF;
        scores[index] = score;
        if (score > 0) positives[speaker] += 1;
      }
    }
    for (let frame = 0; frame < frames; frame += 1) {
      for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
        const index = frame * numSpeakers + speaker;
        const isSpeech = probs[index] > 0.5;
        if (
          isSpeech &&
          !(scores[index] > 0) &&
          positives[speaker] >= this.minPositiveScores
        ) {
          scores[index] = -Infinity;
        }
      }
    }
    return scores;
  }

  /**
   * Keep the `speakerCacheLength` most important frames, grouped by speaker
   * and in their original order within a speaker, with reserved silence slots.
   * @param {Float32Array} embeds
   * @param {Float32Array} probs
   * @param {number} frames
   * @param {Float32Array} silenceEmbeds
   */
  compress(embeds, probs, frames, silenceEmbeds) {
    const {
      numSpeakers,
      hiddenSize,
      speakerCacheLength,
      silenceFramesPerSpeaker,
      latestFramesScoreBoost,
    } = this.config;
    const scores = this.frameScores(probs, frames);
    for (let frame = speakerCacheLength; frame < frames; frame += 1) {
      for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
        scores[frame * numSpeakers + speaker] += latestFramesScoreBoost;
      }
    }
    boostTopFrames(
      scores,
      frames,
      numSpeakers,
      this.numStrongBoosted,
      -2 * LOG_HALF,
    );
    boostTopFrames(scores, frames, numSpeakers, this.numWeakBoosted, -LOG_HALF);

    // Speaker-major flat scores over frames + reserved silence frames (+inf).
    const scoredFrames = frames + silenceFramesPerSpeaker;
    const flatScores = new Float64Array(scoredFrames * numSpeakers);
    for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
      for (let frame = 0; frame < scoredFrames; frame += 1) {
        flatScores[speaker * scoredFrames + frame] =
          frame < frames ? scores[frame * numSpeakers + speaker] : Infinity;
      }
    }
    const sentinel = scoredFrames * numSpeakers;
    const selected = topIndices(flatScores, speakerCacheLength)
      .map((index) => (flatScores[index] === -Infinity ? sentinel : index))
      .sort((a, b) => a - b);

    const outEmbeds = new Float32Array(speakerCacheLength * hiddenSize);
    const outProbs = new Float32Array(speakerCacheLength * numSpeakers);
    selected.forEach((index, slot) => {
      const frame =
        index === sentinel ? frames : Math.min(index % scoredFrames, frames);
      if (frame === frames) {
        // Silence slot: learned silence embedding with zero probabilities.
        outEmbeds.set(silenceEmbeds.subarray(0, hiddenSize), slot * hiddenSize);
        return;
      }
      outEmbeds.set(
        embeds.subarray(frame * hiddenSize, (frame + 1) * hiddenSize),
        slot * hiddenSize,
      );
      outProbs.set(
        probs.subarray(frame * numSpeakers, (frame + 1) * numSpeakers),
        slot * numSpeakers,
      );
    });
    return { embeds: outEmbeds, probs: outProbs };
  }
}

/**
 * Add `boost` to the `count` highest-scoring frames of every speaker column.
 * @param {Float64Array} scores [frames, speakers]
 * @param {number} frames
 * @param {number} numSpeakers
 * @param {number} count
 * @param {number} boost
 */
function boostTopFrames(scores, frames, numSpeakers, count, boost) {
  if (count <= 0) return;
  const column = new Float64Array(frames);
  for (let speaker = 0; speaker < numSpeakers; speaker += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      column[frame] = scores[frame * numSpeakers + speaker];
    }
    for (const frame of topIndices(column, Math.min(count, frames))) {
      scores[frame * numSpeakers + speaker] += boost;
    }
  }
}

/**
 * Indices of the `count` largest values (ties resolved by lower index).
 * @param {Float64Array} values
 * @param {number} count
 * @returns {number[]}
 */
function topIndices(values, count) {
  const order = Array.from({ length: values.length }, (_, index) => index);
  // Comparisons (not subtraction) keep equal infinities ordered by index.
  order.sort((a, b) =>
    values[b] > values[a] ? 1 : values[b] < values[a] ? -1 : a - b,
  );
  return order.slice(0, count);
}

/** @param {number} value */
function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}
