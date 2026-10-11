import { describe, expect, it } from "vitest";
import { selectTranscriptionEngines } from "./engineSelection.js";

const webgpuF16 = { runtime: /** @type {const} */ ("webgpu"), shaderF16: true };
const webgpuNoF16 = {
  runtime: /** @type {const} */ ("webgpu"),
  shaderF16: false,
};
const wasm = { runtime: /** @type {const} */ ("wasm"), shaderF16: false };

describe("selectTranscriptionEngines", () => {
  it("keeps Parakeet for English and matches its runtime tier", () => {
    expect(
      selectTranscriptionEngines({
        language: "en",
        speakerMode: "solo",
        ...webgpuF16,
      }),
    ).toMatchObject({
      available: true,
      asr: { engine: "parakeet", variant: "fp16" },
      diarization: null,
    });
    expect(
      selectTranscriptionEngines({
        language: "en",
        speakerMode: "solo",
        ...wasm,
      }).asr,
    ).toMatchObject({ engine: "parakeet", variant: "int8" });
  });

  it("uses the 120 MB Nemotron int8 model on every tier", () => {
    for (const hardware of [webgpuF16, webgpuNoF16, wasm]) {
      expect(
        selectTranscriptionEngines({
          language: "en",
          speakerMode: "group",
          ...hardware,
        }).diarization,
      ).toMatchObject({ engine: "nemotron", variant: "int8", maxSpeakers: 8 });
    }
  });

  it("can fall back to the legacy four-speaker Sortformer for English", () => {
    expect(
      selectTranscriptionEngines({
        language: "en",
        speakerMode: "group",
        speakerModel: "sortformer",
        ...webgpuF16,
      }).diarization,
    ).toMatchObject({ engine: "sortformer", maxSpeakers: 4 });
  });

  it("uses Qwen3-ASR for Chinese, sized to the WebGPU tier", () => {
    expect(
      selectTranscriptionEngines({
        language: "zh",
        speakerMode: "solo",
        ...webgpuF16,
      }).asr,
    ).toMatchObject({ engine: "qwen3-asr", variant: "q4f16" });
    expect(
      selectTranscriptionEngines({
        language: "zh",
        speakerMode: "solo",
        ...webgpuNoF16,
      }).asr,
    ).toMatchObject({ engine: "qwen3-asr", variant: "q4" });
  });

  it("always diarizes Chinese with Nemotron because Qwen has no word timings", () => {
    expect(
      selectTranscriptionEngines({
        language: "zh",
        speakerMode: "group",
        speakerModel: "sortformer",
        ...webgpuF16,
      }),
    ).toMatchObject({
      asr: { engine: "qwen3-asr" },
      diarization: { engine: "nemotron" },
      diarizeFirst: true,
    });
  });

  it("uses sherpa-onnx clustering with the given count for large groups", () => {
    for (const language of /** @type {const} */ (["en", "zh"])) {
      const selection = selectTranscriptionEngines({
        language,
        speakerMode: "large",
        speakerCount: 12,
        ...webgpuF16,
      });
      expect(selection.diarization).toEqual({
        engine: "sherpa",
        variant: "campplus",
        numSpeakers: 12,
      });
      expect(selection.diarizeFirst).toBe(language === "zh");
      expect(selection.assetKeys).toEqual(
        expect.arrayContaining(["sherpaSegmentation", "sherpaEmbedding"]),
      );
    }
  });

  it("clamps the large-group speaker count", () => {
    const count = (/** @type {number | undefined} */ speakerCount) =>
      selectTranscriptionEngines({
        language: "en",
        speakerMode: "large",
        speakerCount,
        ...wasm,
      }).diarization;
    expect(count(undefined)).toMatchObject({ numSpeakers: 10 });
    expect(count(1)).toMatchObject({ numSpeakers: 2 });
    expect(count(99)).toMatchObject({ numSpeakers: 26 });
    expect(count(7.6)).toMatchObject({ numSpeakers: 8 });
  });

  it("aligns Chinese transcripts for real word timings", () => {
    const selection = selectTranscriptionEngines({
      language: "zh",
      speakerMode: "solo",
      ...webgpuF16,
    });
    expect(selection.aligner).toEqual({
      engine: "qwen3-forced-aligner",
      variant: "q4",
    });
    expect(selection.assetKeys).toEqual(
      expect.arrayContaining(["alignerQ4", "alignerMerges", "qwenVocab"]),
    );
    expect(
      selectTranscriptionEngines({
        language: "en",
        speakerMode: "solo",
        ...webgpuF16,
      }).aligner,
    ).toBeNull();
  });

  it("marks Chinese unavailable without WebGPU", () => {
    const selection = selectTranscriptionEngines({
      language: "zh",
      speakerMode: "solo",
      ...wasm,
    });
    expect(selection.available).toBe(false);
    expect(selection.unavailableReason).toMatch(/WebGPU/);
  });

  it("lists every model asset the selection needs", () => {
    expect(
      selectTranscriptionEngines({
        language: "zh",
        speakerMode: "group",
        ...webgpuF16,
      }).assetKeys,
    ).toEqual([
      "qwenEncoderFp16",
      "qwenDecoderInitQ4f16",
      "qwenDecoderStepQ4f16",
      "qwenDecoderWeightsQ4f16",
      "qwenEmbedTokens",
      "qwenEmbedScales",
      "qwenVocab",
      "alignerQ4",
      "alignerMerges",
      "nemotronInt8",
      "nemotronInt8Data",
    ]);
    expect(
      selectTranscriptionEngines({
        language: "en",
        speakerMode: "group",
        ...wasm,
      }).assetKeys,
    ).toEqual([
      "encoderInt8",
      "decoder",
      "vocab",
      "nemotronInt8",
      "nemotronInt8Data",
    ]);
  });
});
