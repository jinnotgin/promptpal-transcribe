import { describe, expect, it } from "vitest";
import {
  QWEN_ASR_TOKENS,
  buildQwenAsrPrompt,
  collapseRepeatedText,
  createQwenTokenDecoder,
  parseQwenAsrOutput,
  qwenAudioTokenCount,
} from "./qwenAsrPrompt.js";

describe("qwenAudioTokenCount", () => {
  it.each([
    [100, 13],
    [150, 20],
    [75, 10],
    [1, 1],
    [0, 0],
    [2999, 13 * 29 + 13],
  ])("maps %i mel frames to %i audio tokens", (frames, tokens) => {
    expect(qwenAudioTokenCount(frames)).toBe(tokens);
  });
});

describe("buildQwenAsrPrompt", () => {
  it("wraps audio pad tokens in the chat template", () => {
    const prompt = buildQwenAsrPrompt({ audioTokens: 3 });
    expect(Array.from(prompt.ids)).toEqual([
      151644, 9125, 198, 151645, 198, 151644, 882, 198, 151669, 151676, 151676,
      151676, 151670, 151645, 198, 151644, 77091, 198,
    ]);
    expect(prompt.audioStart).toBe(9);
  });

  it("appends forced assistant prefix ids after the template", () => {
    const prompt = buildQwenAsrPrompt({
      audioTokens: 1,
      prefixIds: [11528, 8453, QWEN_ASR_TOKENS.asrText],
    });
    expect(Array.from(prompt.ids.slice(-4))).toEqual([
      198,
      11528,
      8453,
      QWEN_ASR_TOKENS.asrText,
    ]);
  });
});

describe("createQwenTokenDecoder", () => {
  const decoder = createQwenTokenDecoder({
    Hello: 9707,
    Ġworld: 1879,
    "ä½łå¥½": 108386,
    "ï¼Į": 3837,
    language: 11528,
    ĠChinese: 8453,
  });

  it("decodes byte-level BPE tokens to UTF-8 text", () => {
    expect(decoder.decode([9707, 1879, 3837, 108386])).toBe(
      "Hello world，你好",
    );
  });

  it("skips special tokens", () => {
    expect(decoder.decode([108386, QWEN_ASR_TOKENS.imEnd])).toBe("你好");
  });

  it("keeps multi-byte characters split across tokens intact", () => {
    // "你" is three UTF-8 bytes; split it over two synthetic tokens.
    const split = createQwenTokenDecoder({ "ä½": 1, ł: 2 });
    expect(split.decode([1, 2])).toBe("你");
  });
});

describe("parseQwenAsrOutput", () => {
  const decoder = createQwenTokenDecoder({
    language: 11528,
    ĠChinese: 8453,
    ĠNone: 2240,
    "ä½łå¥½": 108386,
  });

  it("separates the detected language from the transcript", () => {
    expect(
      parseQwenAsrOutput(
        [11528, 8453, QWEN_ASR_TOKENS.asrText, 108386],
        decoder,
      ),
    ).toEqual({ language: "Chinese", text: "你好", hasHeader: true });
  });

  it("treats output without the asr marker as transcript text", () => {
    expect(parseQwenAsrOutput([108386], decoder)).toEqual({
      language: null,
      text: "你好",
      hasHeader: false,
    });
  });

  it("reports empty output for non-speech", () => {
    expect(
      parseQwenAsrOutput([11528, 8453, QWEN_ASR_TOKENS.asrText], decoder),
    ).toEqual({ language: "Chinese", text: "", hasHeader: true });
  });

  it("treats a 'language None' header as no speech and drops trailing text", () => {
    expect(
      parseQwenAsrOutput(
        [11528, 2240, QWEN_ASR_TOKENS.asrText, 108386],
        decoder,
      ),
    ).toEqual({ language: null, text: "", hasHeader: true });
  });

  it("collapses runaway repeats in the transcript", () => {
    const looped = createQwenTokenDecoder({ Okay: 1, ".": 2, ĠOkay: 3 });
    const ids = [1, 2];
    for (let index = 0; index < 10; index += 1) ids.push(3, 2);
    expect(parseQwenAsrOutput(ids, looped).text).toBe("Okay.");
  });
});

describe("collapseRepeatedText", () => {
  it("keeps one copy of a phrase repeated six or more times", () => {
    expect(collapseRepeatedText(`Hi. ${"Okay. ".repeat(6)}Bye.`)).toBe(
      "Hi. Okay. Bye.",
    );
    expect(collapseRepeatedText("我，不，确，我，不，确，".repeat(3))).toBe(
      "我，不，确，",
    );
  });

  it("leaves short natural repetition alone", () => {
    for (const text of [
      "translate, translate like translate",
      "Okay. Okay. Okay.",
      "哈哈哈哈哈哈",
      "no no no no no",
    ]) {
      expect(collapseRepeatedText(text)).toBe(text);
    }
  });

  it("collapses a single character repeated more than twenty times", () => {
    expect(collapseRepeatedText(`啊${"。".repeat(30)}好`)).toBe("啊。好");
  });
});
