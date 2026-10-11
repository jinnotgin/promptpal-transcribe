import { describe, expect, it } from "vitest";
import { QWEN_ASR_TOKENS, createQwenTokenDecoder } from "./qwenAsrPrompt.js";
import {
  generateQwenTranscript,
  qwenMaxNewTokens,
} from "./qwenAsrGeneration.js";

const HIDDEN = 4;
const decoder = createQwenTokenDecoder({
  language: 11528,
  ĠChinese: 8453,
  ĠNone: 2240,
  "ä½łå¥½": 108386,
  "ï¼Į": 3837,
});

/**
 * @param {number[]} script tokens to emit, one per decoding step
 */
function createFakeModel(script) {
  const calls = {
    prefillRows: 0,
    prefills: 0,
    prefillEmbeds: new Float32Array(0),
    steps: /** @type {number[]} */ ([]),
  };
  const logitsFor = (/** @type {number} */ token) => {
    const logits = new Float32Array(151936);
    logits[token] = 10;
    return logits;
  };
  let cursor = 0;
  return {
    calls,
    model: {
      hiddenSize: HIDDEN,
      async encode(
        /** @type {Float32Array} */ _features,
        /** @type {number} */ frames,
      ) {
        const tokens = frames >= 100 ? 13 : 2;
        return new Float32Array(tokens * HIDDEN).fill(7);
      },
      embed(/** @type {ArrayLike<number>} */ ids) {
        const out = new Float32Array(ids.length * HIDDEN);
        for (let index = 0; index < ids.length; index += 1)
          out[index * HIDDEN] = ids[index];
        return out;
      },
      async prefill(
        /** @type {Float32Array} */ embeds,
        /** @type {number} */ rows,
      ) {
        calls.prefillRows = rows;
        calls.prefills += 1;
        calls.prefillEmbeds = embeds;
        return logitsFor(script[cursor++] ?? QWEN_ASR_TOKENS.imEnd);
      },
      async step(
        /** @type {Float32Array} */ embed,
        /** @type {number} */ position,
      ) {
        calls.steps.push(position);
        return logitsFor(script[cursor++] ?? QWEN_ASR_TOKENS.imEnd);
      },
      reset() {},
    },
  };
}

describe("generateQwenTranscript", () => {
  it("splices encoder output over the audio pads and decodes until EOS", async () => {
    const fake = createFakeModel([
      11528,
      8453,
      QWEN_ASR_TOKENS.asrText,
      108386,
      3837,
      QWEN_ASR_TOKENS.imEnd,
      108386,
    ]);
    const pcm = new Float32Array(16000);
    const result = await generateQwenTranscript({
      pcm,
      model: fake.model,
      decoder,
    });

    expect(result).toMatchObject({ language: "Chinese", text: "你好，" });
    // 100 mel frames -> 13 audio tokens between a 9-token prefix and 6-token suffix.
    expect(fake.calls.prefillRows).toBe(9 + 13 + 6);
    expect(fake.calls.prefillEmbeds[9 * HIDDEN]).toBe(7);
    expect(fake.calls.prefillEmbeds[(9 + 13) * HIDDEN]).toBe(
      QWEN_ASR_TOKENS.audioEnd,
    );
    expect(fake.calls.steps).toEqual([28, 29, 30, 31, 32]);
  });

  it("keeps headerless transcript text without retrying", async () => {
    const fake = createFakeModel([108386, QWEN_ASR_TOKENS.imEnd]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
    });
    expect(result).toMatchObject({
      text: "你好",
      language: null,
      headerForced: false,
    });
    expect(fake.calls.prefills).toBe(1);
  });

  it("retries an immediately empty decode by forcing only the header keyword", async () => {
    const fake = createFakeModel([
      QWEN_ASR_TOKENS.imEnd,
      8453,
      QWEN_ASR_TOKENS.asrText,
      108386,
      QWEN_ASR_TOKENS.imEnd,
    ]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
    });
    expect(result).toMatchObject({
      text: "你好",
      language: "Chinese",
      headerForced: true,
      forcedLanguage: null,
    });
    expect(fake.calls.prefills).toBe(2);
    // The retry prompt ends with "language" but leaves the name to the model.
    const lastRow = fake.calls.prefillRows - 1;
    expect(fake.calls.prefillEmbeds[lastRow * HIDDEN]).toBe(11528);
  });

  it("does not retry when the model reports no speech", async () => {
    const fake = createFakeModel([
      11528,
      2240,
      QWEN_ASR_TOKENS.asrText,
      QWEN_ASR_TOKENS.imEnd,
    ]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
    });
    expect(result.text).toBe("");
    expect(fake.calls.prefills).toBe(1);
  });

  it("forces the full header only for an explicit language", async () => {
    const fake = createFakeModel([108386, QWEN_ASR_TOKENS.imEnd]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
      language: "zh",
    });
    expect(result).toMatchObject({
      text: "你好",
      language: "Chinese",
      forcedLanguage: "zh",
    });
  });

  it("stops a degenerate single-token loop and keeps one copy", async () => {
    const fake = createFakeModel([
      11528,
      8453,
      QWEN_ASR_TOKENS.asrText,
      ...new Array(60).fill(108386),
    ]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
    });
    expect(result.text).toBe("你好");
    expect(fake.calls.steps.length).toBeLessThan(30);
  });

  it("stops a multi-token phrase loop and keeps one copy", async () => {
    const loop = [];
    for (let index = 0; index < 60; index += 1) loop.push(108386, 3837);
    const fake = createFakeModel([
      11528,
      8453,
      QWEN_ASR_TOKENS.asrText,
      ...loop,
    ]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
    });
    expect(result.text).toBe("你好，");
    expect(fake.calls.steps.length).toBeLessThan(30);
  });

  it("stops at the token budget", async () => {
    const fake = createFakeModel(new Array(50).fill(108386));
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
      maxNewTokens: 4,
    });
    expect(result.tokens).toHaveLength(4);
  });

  it("returns empty text for audio too short to encode", async () => {
    const fake = createFakeModel([]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(80),
      model: fake.model,
      decoder,
    });
    expect(result.text).toBe("");
    expect(fake.calls.prefillRows).toBe(0);
  });
});

describe("qwenMaxNewTokens", () => {
  it("scales with duration within bounds", () => {
    expect(qwenMaxNewTokens(1)).toBe(72);
    expect(qwenMaxNewTokens(20)).toBe(224);
    expect(qwenMaxNewTokens(120)).toBe(512);
  });
});
