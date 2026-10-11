import { describe, expect, it } from "vitest";
import {
  LARGE_GROUP_SPEAKERS,
  clampLargeGroupSpeakers,
  normalizeTranscriptionLanguage,
  selectTranscriptionEngines,
} from "./engineSelection.js";

describe("selectTranscriptionEngines", () => {
  it("matches Parakeet's variant to the runtime tier", () => {
    expect(
      selectTranscriptionEngines({ speakerMode: "solo", runtime: "webgpu" }),
    ).toMatchObject({
      asr: { engine: "parakeet", variant: "fp16" },
      diarization: null,
      assetKeys: ["encoderFp16", "decoder", "vocab"],
    });
    expect(
      selectTranscriptionEngines({ speakerMode: "solo", runtime: "wasm" }),
    ).toMatchObject({
      asr: { engine: "parakeet", variant: "int8" },
      assetKeys: ["encoderInt8", "decoder", "vocab"],
    });
  });

  it("uses Nemotron for groups of up to 8 on every runtime", () => {
    for (const runtime of /** @type {const} */ (["webgpu", "wasm"])) {
      const selection = selectTranscriptionEngines({
        speakerMode: "group",
        runtime,
      });
      expect(selection.diarization).toEqual({
        engine: "nemotron",
        variant: "int8",
        maxSpeakers: 8,
      });
      expect(selection.assetKeys).toEqual(
        expect.arrayContaining(["nemotronInt8", "nemotronInt8Data"]),
      );
    }
  });

  it("clusters large groups into the requested speaker count", () => {
    const selection = selectTranscriptionEngines({
      speakerMode: "large",
      runtime: "webgpu",
      speakerCount: 12,
    });
    expect(selection.diarization).toEqual({
      engine: "sherpa",
      variant: "campplus",
      numSpeakers: 12,
    });
    expect(selection.assetKeys).toEqual([
      "encoderFp16",
      "decoder",
      "vocab",
      "sherpaSegmentation",
      "sherpaEmbedding",
    ]);
  });

  it("keeps large-group counts above the Nemotron limit", () => {
    expect(
      selectTranscriptionEngines({
        speakerMode: "large",
        runtime: "wasm",
        speakerCount: 3,
      }).diarization,
    ).toMatchObject({ numSpeakers: LARGE_GROUP_SPEAKERS.min });
  });
});

describe("language selection", () => {
  it("uses SenseVoice for Chinese and mixed audio on every runtime", () => {
    for (const runtime of /** @type {const} */ (["webgpu", "wasm"])) {
      for (const language of /** @type {const} */ (["zh", "zh-en"])) {
        expect(
          selectTranscriptionEngines({
            speakerMode: "solo",
            runtime,
            language,
          }),
        ).toMatchObject({
          asr: { engine: "sensevoice", variant: "int8" },
          assetKeys: ["senseVoiceInt8", "senseVoiceTokens"],
        });
      }
    }
  });

  it("hints Chinese to SenseVoice and auto-detects mixed audio", () => {
    const asrFor = (/** @type {'zh' | 'zh-en'} */ language) =>
      selectTranscriptionEngines({
        speakerMode: "solo",
        runtime: "wasm",
        language,
      }).asr;
    expect(asrFor("zh")).toEqual({
      engine: "sensevoice",
      variant: "int8",
      language: "zh",
    });
    expect(asrFor("zh-en")).toEqual({
      engine: "sensevoice",
      variant: "int8",
      language: "auto",
    });
  });

  it("pairs SenseVoice with the chosen diarizer", () => {
    expect(
      selectTranscriptionEngines({
        speakerMode: "group",
        runtime: "webgpu",
        language: "zh-en",
      }).assetKeys,
    ).toEqual([
      "senseVoiceInt8",
      "senseVoiceTokens",
      "nemotronInt8",
      "nemotronInt8Data",
    ]);
  });

  it("defaults to Parakeet for English", () => {
    expect(
      selectTranscriptionEngines({
        speakerMode: "solo",
        runtime: "webgpu",
        language: "en",
      }).asr,
    ).toEqual({ engine: "parakeet", variant: "fp16" });
  });

  it("normalizes stored values, falling back to English", () => {
    expect(normalizeTranscriptionLanguage("zh-en")).toBe("zh-en");
    expect(normalizeTranscriptionLanguage("zh")).toBe("zh");
    expect(normalizeTranscriptionLanguage("en")).toBe("en");
    expect(normalizeTranscriptionLanguage(undefined)).toBe("en");
    expect(normalizeTranscriptionLanguage("fr")).toBe("en");
  });
});

describe("clampLargeGroupSpeakers", () => {
  it("rounds and clamps to the large-group range", () => {
    expect(LARGE_GROUP_SPEAKERS).toMatchObject({ min: 9, max: 26 });
    expect(clampLargeGroupSpeakers(12.4)).toBe(12);
    expect(clampLargeGroupSpeakers(2)).toBe(9);
    expect(clampLargeGroupSpeakers(40)).toBe(26);
    expect(clampLargeGroupSpeakers(undefined)).toBe(
      LARGE_GROUP_SPEAKERS.default,
    );
    expect(clampLargeGroupSpeakers(Number.NaN)).toBe(
      LARGE_GROUP_SPEAKERS.default,
    );
  });
});
