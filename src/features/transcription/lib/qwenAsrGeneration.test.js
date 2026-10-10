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
  "ä½łå¥½": 108386,
  "ï¼Į": 3837,
});

/**
 * @param {number[]} script tokens to emit, one per decoding step
 */
function createFakeModel(script) {
  const calls = {
    prefillRows: 0,
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

  it("retries with a forced language when the model skips the language header", async () => {
    const fake = createFakeModel([
      QWEN_ASR_TOKENS.imEnd,
      108386,
      QWEN_ASR_TOKENS.imEnd,
    ]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
      fallbackLanguage: "zh",
    });
    expect(result).toMatchObject({ text: "你好", forcedLanguage: "zh" });
  });

  it("stops a degenerate single-token loop and drops the repeats", async () => {
    const fake = createFakeModel([
      11528,
      8453,
      QWEN_ASR_TOKENS.asrText,
      108386,
      ...new Array(60).fill(0),
    ]);
    const result = await generateQwenTranscript({
      pcm: new Float32Array(16000),
      model: fake.model,
      decoder,
    });
    expect(result.text).toBe("你好");
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
