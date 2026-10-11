import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/qwenAligner.fixture.json";
import {
  ALIGNER_TOKENS,
  buildAlignerPrompt,
  createQwenBpeEncoder,
  splitAlignerUnits,
} from "./qwenAlignerText.js";

const encoder = createQwenBpeEncoder({
  vocab: fixture.vocab,
  merges: /** @type {Array<[number, string]>} */ (fixture.merges),
});

describe("splitAlignerUnits", () => {
  for (const testCase of fixture.cases) {
    it(`splits like the reference aligner: ${JSON.stringify(testCase.text)}`, () => {
      const units = splitAlignerUnits(testCase.text);
      expect(units.map((unit) => unit.text)).toEqual(testCase.words);
    });
  }

  it("records where each unit sits in the source text", () => {
    const text = "这个 budget 够不够？";
    const units = splitAlignerUnits(text);
    expect(units.map((unit) => text.slice(unit.start, unit.end))).toEqual([
      "这",
      "个",
      "budget",
      "够",
      "不",
      "够",
    ]);
  });

  it("spans dropped punctuation inside a joined unit", () => {
    const text = "e-mail me";
    expect(splitAlignerUnits(text)).toEqual([
      { text: "email", start: 0, end: 6 },
      { text: "me", start: 7, end: 9 },
    ]);
  });
});

describe("buildAlignerPrompt", () => {
  // Text without units is never aligned (the reference still appends slots).
  for (const testCase of fixture.cases.filter((c) => c.words.length)) {
    it(`matches the reference prompt ids: ${JSON.stringify(testCase.text)}`, () => {
      const units = splitAlignerUnits(testCase.text);
      const { ids, timestampPositions } = buildAlignerPrompt({
        audioTokens: 1,
        units: units.map((unit) => encoder.encode(unit.text)),
      });
      expect(ids).toEqual(testCase.promptIds);
      expect(timestampPositions).toHaveLength(units.length * 2);
      for (const position of timestampPositions) {
        expect(ids[position]).toBe(ALIGNER_TOKENS.timestamp);
      }
    });
  }

  it("expands the audio placeholder to the encoder token count", () => {
    const { ids } = buildAlignerPrompt({ audioTokens: 3, units: [[9]] });
    expect(ids).toEqual([
      ALIGNER_TOKENS.audioStart,
      ALIGNER_TOKENS.audioPad,
      ALIGNER_TOKENS.audioPad,
      ALIGNER_TOKENS.audioPad,
      ALIGNER_TOKENS.audioEnd,
      9,
      ALIGNER_TOKENS.timestamp,
      ALIGNER_TOKENS.timestamp,
    ]);
  });
});
