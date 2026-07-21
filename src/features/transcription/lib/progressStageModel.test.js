import { describe, expect, it } from "vitest";
import {
  createProgressStages,
  getProgressStageKey,
} from "./progressStageModel.js";

describe("transcription progress stage model", () => {
  it("shows only the three user-visible macro stages when diarization is enabled", () => {
    expect(createProgressStages(true)).toEqual([
      { key: "downloading-model", label: "Preparing models" },
      { key: "transcribing", label: "Transcribing" },
      { key: "diarizing", label: "Identifying speakers" },
    ]);
  });

  it("omits speaker identification when diarization is disabled", () => {
    expect(createProgressStages(false)).toEqual([
      { key: "downloading-model", label: "Preparing models" },
      { key: "transcribing", label: "Transcribing" },
    ]);
  });

  it.each(["transcoding", "vad", "transcribing"])(
    "keeps the internal %s phase within Transcribing",
    (phase) => {
      expect(getProgressStageKey(phase)).toBe("transcribing");
    },
  );
});
