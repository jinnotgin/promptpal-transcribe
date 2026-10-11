import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useTranscriptionStore } from "./transcriptionStore.js";

describe("transcription engine settings", () => {
  beforeEach(() => {
    const values = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      clear: () => values.clear(),
    });
    setActivePinia(createPinia());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("derives the engine selection from language, speakers and hardware", () => {
    const store = useTranscriptionStore();
    store.setHardwareCapability({
      supported: true,
      backend: "webgpu",
      version: "fp16",
      webgpuAvailable: true,
      shaderF16: true,
      reason: "",
      advisory: "none",
    });
    store.setLanguage("zh");
    store.setEnableDiarization(true);

    expect(store.engineSelection).toMatchObject({
      available: true,
      asr: { engine: "qwen3-asr", variant: "q4f16" },
      diarization: { engine: "nemotron" },
      diarizeFirst: true,
    });

    store.setEnableDiarization(false);
    store.setLanguage("en");
    expect(store.engineSelection).toMatchObject({
      asr: { engine: "parakeet", variant: "fp16" },
      diarization: null,
    });
  });

  it("persists the language and speaker model choices", () => {
    const store = useTranscriptionStore();
    store.setLanguage("zh");
    store.setSpeakerModel("sortformer");

    setActivePinia(createPinia());
    const reloaded = useTranscriptionStore();
    expect(reloaded.language).toBe("zh");
    expect(reloaded.speakerModel).toBe("sortformer");
  });

  it("selects the large-group diarizer with a persisted speaker count", () => {
    const store = useTranscriptionStore();
    store.setEnableDiarization(true);
    expect(store.speakerScale).toBe("group");
    expect(store.speakerCount).toBe(10);
    store.setSpeakerScale("large");
    store.setSpeakerCount(14);
    expect(store.engineSelection.diarization).toEqual({
      engine: "sherpa",
      variant: "campplus",
      numSpeakers: 14,
    });
    store.setSpeakerCount(400);
    expect(store.speakerCount).toBe(26);

    setActivePinia(createPinia());
    const reloaded = useTranscriptionStore();
    expect(reloaded.speakerScale).toBe("large");
    expect(reloaded.speakerCount).toBe(26);
    reloaded.setEnableDiarization(false);
    expect(reloaded.engineSelection.diarization).toBeNull();
  });
});
