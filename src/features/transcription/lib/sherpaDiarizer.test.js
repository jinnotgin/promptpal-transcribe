import { describe, expect, it } from "vitest";
import {
  PYANNOTE_SEGMENTATION_META,
  chunkSpeakerRanges,
  createSherpaDiarizer,
  powersetMapping,
} from "./sherpaDiarizer.js";

const SAMPLE_RATE = 16000;
const FRAMES = 589;
const CLASSES = 7;

/**
 * Speaker k talks as an amplitude-modulated tone at 300 + 200k Hz.
 * @param {Array<{ speaker: number, start: number, end: number }>} turns
 * @param {number} seconds
 */
function synthesize(turns, seconds) {
  const pcm = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (const { speaker, start, end } of turns) {
    const freq = 300 + 200 * speaker;
    for (
      let i = Math.round(start * SAMPLE_RATE);
      i < Math.round(end * SAMPLE_RATE);
      i += 1
    ) {
      const t = i / SAMPLE_RATE;
      pcm[i] =
        (0.5 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) *
        Math.sin(2 * Math.PI * freq * t);
    }
  }
  return pcm;
}

/**
 * Fake segmentation: estimates each frame's tone from zero crossings and
 * maps distinct tones to local speaker slots in order of appearance.
 * @param {Float32Array} chunk
 */
async function fakeSegmentation(chunk) {
  const logits = new Float32Array(FRAMES * CLASSES).fill(-10);
  /** @type {Map<number, number>} */
  const slots = new Map();
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const from = Math.min(chunk.length - 270, frame * 270 + 360);
    let crossings = 0;
    let silent = 0;
    for (let i = from + 1; i < from + 270; i += 1) {
      if (chunk[i] === 0) silent += 1;
      else if (chunk[i - 1] < 0 !== chunk[i] < 0) crossings += 1;
    }
    let cls = 0;
    // Frames straddling a turn edge are treated as silence.
    if (silent === 0 && crossings > 4) {
      const freq = (crossings / 2) * (SAMPLE_RATE / 270);
      const speaker = Math.round((freq - 300) / 200);
      if (!slots.has(speaker) && slots.size < 3) slots.set(speaker, slots.size);
      cls = slots.has(speaker)
        ? 1 + /** @type {number} */ (slots.get(speaker))
        : 0;
    }
    logits[frame * CLASSES + cls] = 0;
  }
  return { logits, frames: FRAMES };
}

/**
 * Fake embedding features: the dominant tone from zero crossings, so the
 * speaker is recoverable (the real fbank has its own parity test).
 * @param {Float32Array} audio
 */
function toneFeatures(audio) {
  let crossings = 0;
  for (let i = 1; i < audio.length; i += 1) {
    if (audio[i - 1] < 0 !== audio[i] < 0) crossings += 1;
  }
  const freq = (crossings / 2) * (SAMPLE_RATE / audio.length);
  return { features: Float32Array.of(freq), frames: 1 };
}

/** One-hot embedding of the speaker whose tone the features carry. */
async function fakeEmbedding(/** @type {Float32Array} */ features) {
  const out = new Float32Array(16).fill(0.01);
  out[Math.round((features[0] - 300) / 200)] = 1;
  return out;
}

/** @param {Float32Array} pcm @param {number[]} pieces */
async function diarize(pcm, numClusters, pieces = [pcm.length]) {
  const diarizer = createSherpaDiarizer({
    runSegmentation: fakeSegmentation,
    runEmbedding: fakeEmbedding,
    embeddingFeatures: toneFeatures,
    numClusters,
  });
  let offset = 0;
  let index = 0;
  while (offset < pcm.length) {
    const size = pieces[index % pieces.length];
    await diarizer.pushPcm(pcm.subarray(offset, offset + size));
    offset += size;
    index += 1;
  }
  return diarizer.finish();
}

const TEN_SPEAKERS = Array.from({ length: 10 }, (_, speaker) => ({
  speaker,
  start: speaker * 6 + 0.5,
  end: speaker * 6 + 5.5,
}));

describe("powersetMapping", () => {
  it("maps silence, single speakers, then speaker pairs", () => {
    expect(Array.from(powersetMapping(7, 3))).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1,
    ]);
  });
});

describe("chunkSpeakerRanges", () => {
  it("drops overlapped frames and speakers under 10 frames", () => {
    const frames = 40;
    const labels = new Int8Array(frames * 3);
    for (let f = 0; f < 20; f += 1) labels[f * 3] = 1;
    for (let f = 15; f < 30; f += 1) labels[f * 3 + 1] = 1;
    for (let f = 32; f < 38; f += 1) labels[f * 3 + 2] = 1;
    const ranges = chunkSpeakerRanges(
      labels,
      frames,
      PYANNOTE_SEGMENTATION_META,
      16000,
    );
    expect(ranges).toEqual([
      { speaker: 0, ranges: [[16000, 16000 + 60000]] },
      { speaker: 1, ranges: [[16000 + 80000, 16000 + 120000]] },
    ]);
  });
});

describe("createSherpaDiarizer", () => {
  it("separates more than eight speakers when given the count", async () => {
    const pcm = synthesize(TEN_SPEAKERS, 61);
    const segments = await diarize(pcm, 10);
    const speakers = new Set(segments.map((segment) => segment.speaker));
    expect(speakers.size).toBe(10);
    for (const turn of TEN_SPEAKERS) {
      const overlapping = segments.filter(
        (segment) =>
          segment.end > turn.start + 0.5 && segment.start < turn.end - 0.5,
      );
      expect(new Set(overlapping.map((segment) => segment.speaker)).size).toBe(
        1,
      );
      const spans = overlapping.flatMap((segment) => [
        segment.start,
        segment.end,
      ]);
      expect(Math.min(...spans)).toBeCloseTo(turn.start, 0);
      expect(Math.max(...spans)).toBeCloseTo(turn.end, 0);
    }
  });

  it("gives the same result however the audio is split", async () => {
    const pcm = synthesize(TEN_SPEAKERS.slice(0, 4), 25.3);
    const whole = await diarize(pcm, 4);
    const pieces = await diarize(pcm, 4, [1, 4999, 160000, 23456, 777]);
    expect(pieces).toEqual(whole);
  });

  it("labels local speakers directly for audio within one chunk", async () => {
    const pcm = synthesize(
      [
        { speaker: 2, start: 0.5, end: 3.5 },
        { speaker: 5, start: 4.5, end: 8 },
      ],
      8.4,
    );
    const segments = await diarize(pcm, 2);
    expect(segments.map((segment) => segment.speaker)).toEqual([0, 1]);
    expect(segments[0].start).toBeCloseTo(0.5, 0);
    expect(segments[1].end).toBeCloseTo(8, 0);
  });

  it("reports the audio processed after each chunk", async () => {
    /** @type {number[]} */
    const processed = [];
    const diarizer = createSherpaDiarizer({
      runSegmentation: fakeSegmentation,
      runEmbedding: fakeEmbedding,
      embeddingFeatures: toneFeatures,
      numClusters: 2,
      onChunk: (seconds) => processed.push(seconds),
    });
    await diarizer.pushPcm(new Float32Array(SAMPLE_RATE * 12));
    expect(processed).toEqual([1, 2, 3]);
  });

  it("returns nothing for silence", async () => {
    expect(await diarize(new Float32Array(SAMPLE_RATE * 15), 3)).toEqual([]);
  });
});
