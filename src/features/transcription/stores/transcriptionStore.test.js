import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useTranscriptionStore } from "./transcriptionStore.js";

describe("speaker identification settings", () => {
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

  it("defaults to Nemotron for groups of up to 8 speakers", () => {
    const store = useTranscriptionStore();
    store.setHardwareCapability({
      supported: true,
      backend: "webgpu",
      version: "fp16",
      webgpuAvailable: true,
      reason: "",
      advisory: "none",
    });

    expect(store.enableDiarization).toBe(true);
    expect(store.speakerScale).toBe("group");
    expect(store.engineSelection).toMatchObject({
      asr: { engine: "parakeet", variant: "fp16" },
      diarization: { engine: "nemotron", maxSpeakers: 8 },
    });

    store.setEnableDiarization(false);
    expect(store.engineSelection.diarization).toBeNull();
  });

  it("selects the large-group diarizer for the chosen speaker count", () => {
    const store = useTranscriptionStore();
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
  });

  it("does not remember speaker settings across reloads", () => {
    localStorage.setItem("transcription-speaker-scale", "large");
    localStorage.setItem("transcription-speaker-count", "14");
    const store = useTranscriptionStore();
    store.setEnableDiarization(false);
    store.setSpeakerScale("large");
    store.setSpeakerCount(20);

    setActivePinia(createPinia());
    const reloaded = useTranscriptionStore();
    expect(reloaded.enableDiarization).toBe(true);
    expect(reloaded.speakerScale).toBe("group");
    expect(reloaded.speakerCount).toBe(10);
  });

  it("picks SenseVoice for Chinese and mixed recordings", () => {
    const store = useTranscriptionStore();
    expect(store.transcriptionLanguage).toBe("en");
    store.setTranscriptionLanguage("zh-en");
    expect(store.engineSelection.asr).toEqual({
      engine: "sensevoice",
      variant: "int8",
      language: "auto",
    });
    store.setTranscriptionLanguage("zh");
    expect(store.engineSelection.asr).toMatchObject({ language: "zh" });
  });

  it("does not remember the transcription language across reloads", () => {
    localStorage.setItem("transcription-language", "zh");
    const store = useTranscriptionStore();
    expect(store.transcriptionLanguage).toBe("en");
    store.setTranscriptionLanguage("zh-en");

    setActivePinia(createPinia());
    expect(useTranscriptionStore().transcriptionLanguage).toBe("en");
  });

  it("resets language and speaker settings when a new file is chosen", () => {
    const store = useTranscriptionStore();
    store.setTranscriptionLanguage("zh");
    store.setEnableDiarization(false);
    store.setSpeakerScale("large");
    store.setSpeakerCount(20);

    store.setFile(new File(["audio"], "next.mp3", { type: "audio/mpeg" }));

    expect(store.transcriptionLanguage).toBe("en");
    expect(store.enableDiarization).toBe(true);
    expect(store.speakerScale).toBe("group");
    expect(store.speakerCount).toBe(10);
  });
});
