import { describe, expect, it } from "vitest";
import {
  TRANSCRIPTION_ROUTE_NAMES,
  getTranscriptionRouteState,
  transcriptionDetailLocation,
  transcriptionHistoryLocation,
  transcriptionStartLocation,
} from "./transcriptionRoutes.js";

describe("transcriptionRoutes", () => {
  it("builds stable named route locations", () => {
    expect(transcriptionStartLocation()).toEqual({
      name: TRANSCRIPTION_ROUTE_NAMES.start,
    });
    expect(transcriptionHistoryLocation()).toEqual({
      name: TRANSCRIPTION_ROUTE_NAMES.history,
    });
    expect(transcriptionDetailLocation("record / 1")).toEqual({
      name: TRANSCRIPTION_ROUTE_NAMES.detail,
      params: { transcriptId: "record / 1" },
    });
  });

  it("normalizes the start route", () => {
    expect(
      getTranscriptionRouteState({ name: TRANSCRIPTION_ROUTE_NAMES.start }),
    ).toEqual({
      surface: "start",
      transcriptId: null,
    });
  });

  it("normalizes the history route", () => {
    expect(
      getTranscriptionRouteState({ name: TRANSCRIPTION_ROUTE_NAMES.history }),
    ).toEqual({
      surface: "history",
      transcriptId: null,
    });
  });

  it("normalizes a transcript detail route", () => {
    expect(
      getTranscriptionRouteState({
        name: TRANSCRIPTION_ROUTE_NAMES.detail,
        params: { transcriptId: "record-1" },
      }),
    ).toEqual({ surface: "detail", transcriptId: "record-1" });
  });

  it("treats a missing or repeated detail param as an invalid detail", () => {
    expect(
      getTranscriptionRouteState({
        name: TRANSCRIPTION_ROUTE_NAMES.detail,
        params: {},
      }),
    ).toEqual({ surface: "invalid-detail", transcriptId: null });
    expect(
      getTranscriptionRouteState({
        name: TRANSCRIPTION_ROUTE_NAMES.detail,
        params: { transcriptId: ["one", "two"] },
      }),
    ).toEqual({ surface: "invalid-detail", transcriptId: null });
  });
});
