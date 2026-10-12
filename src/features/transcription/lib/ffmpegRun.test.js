import { describe, expect, it } from "vitest";
import { createFfmpegLogTail, runFfmpegStep } from "./ffmpegRun.js";

describe("createFfmpegLogTail", () => {
  it("keeps only the most recent non-empty lines", () => {
    const tail = createFfmpegLogTail(2);
    tail.push("first");
    tail.push("   ");
    tail.push("second");
    tail.push("third");
    expect(tail.lines()).toEqual(["second", "third"]);
  });

  it("clears collected lines", () => {
    const tail = createFfmpegLogTail();
    tail.push("noise");
    tail.clear();
    expect(tail.lines()).toEqual([]);
  });
});

describe("runFfmpegStep", () => {
  it("returns normally when FFmpeg exits with code 0", async () => {
    const tail = createFfmpegLogTail();
    await expect(
      runFfmpegStep("Audio decode", tail, async () => 0),
    ).resolves.toBeUndefined();
  });

  it("throws the stage, exit code, and last log lines on failure", async () => {
    const tail = createFfmpegLogTail();
    tail.push("stale line from an earlier run");
    await expect(
      runFfmpegStep("Review proxy encode", tail, async () => {
        tail.push("Stream #0:0: Audio: aac");
        tail.push("Unknown encoder 'libopus'");
        return 1;
      }),
    ).rejects.toThrow(
      "Review proxy encode failed (FFmpeg exit 1): Stream #0:0: Audio: aac | Unknown encoder 'libopus'",
    );
  });

  it("reports the exit code alone when FFmpeg logged nothing", async () => {
    const tail = createFfmpegLogTail();
    await expect(
      runFfmpegStep("Duration probe", tail, async () => -1),
    ).rejects.toThrow("Duration probe failed (FFmpeg exit -1)");
  });
});
