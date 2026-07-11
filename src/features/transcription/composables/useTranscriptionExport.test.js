import { describe, expect, it, vi, beforeEach } from "vitest";
import { saveAs } from "file-saver";
import { useTranscriptionExport } from "./useTranscriptionExport.js";

vi.mock("file-saver", () => ({
  saveAs: vi.fn(),
}));

const makeStore = () => ({
  fileName: "customer-call.wav",
  displaySegments: [
    { start: 0, end: 2.5, speaker: "Speaker 1", text: " Hello there " },
    { start: 62.25, end: 64, speaker: "Speaker 2", text: "General Kenobi." },
  ],
});

describe("useTranscriptionExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      format: "txt",
      filename: "customer-call.txt",
      expectedContent:
        "[0:00 Speaker 1] Hello there\n\n[1:02 Speaker 2] General Kenobi.",
      expectedType: "text/plain;charset=utf-8",
    },
    {
      format: "md",
      filename: "customer-call.md",
      expectedContent:
        "**[0:00 Speaker 1]** Hello there\n\n**[1:02 Speaker 2]** General Kenobi.",
      expectedType: "text/markdown;charset=utf-8",
    },
    {
      format: "srt",
      filename: "customer-call.srt",
      expectedContent:
        "1\n00:00:00,000 --> 00:00:02,500\nSpeaker 1: Hello there\n\n2\n00:01:02,250 --> 00:01:04,000\nSpeaker 2: General Kenobi.",
      expectedType: "application/x-subrip;charset=utf-8",
    },
  ])("saves $format transcript exports with file-saver", async (caseData) => {
    const { exportTranscript } = useTranscriptionExport(
      /** @type {any} */ (makeStore()),
    );

    exportTranscript(/** @type {'txt' | 'md' | 'srt'} */ (caseData.format));

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(saveAs).mock.calls[0];
    expect(filename).toBe(caseData.filename);
    expect(blob.type).toBe(caseData.expectedType);
    await expect(blob.text()).resolves.toBe(caseData.expectedContent);
  });
});
