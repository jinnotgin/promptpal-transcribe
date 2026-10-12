import { describe, expect, it, vi } from "vitest";
import { useTranscriptReprocess } from "./useTranscriptReprocess.js";

const manifest = /** @type {any} */ ({ version: 1, duration: 3, parts: [] });

function makeStore() {
  return /** @type {any} */ ({
    processPhase: "complete",
    error: null,
    segments: [{ id: "old", text: "original", speaker: "SPEAKER_0" }],
    speakerNames: { SPEAKER_0: "Alice" },
    speakerColors: { SPEAKER_0: "#ff0000" },
    addedSpeakerIds: ["SPEAKER_0"],
  });
}

/**
 * A pipeline whose reprocess wipes the transcript like the real one, then
 * settles when the test says so.
 */
function makePipeline(store) {
  /** @type {(outcome: string) => void} */
  let settle = () => {};
  const pipeline = {
    reprocessFromManifest: vi.fn(() => {
      store.segments = [];
      store.speakerNames = {};
      store.speakerColors = {};
      store.addedSpeakerIds = [];
      store.processPhase = "transcribing";
      return new Promise((resolve) => {
        settle = resolve;
      });
    }),
    cancel: vi.fn(() => settle("cancelled")),
  };
  return {
    pipeline,
    finish(outcome) {
      settle(outcome);
    },
  };
}

describe("useTranscriptReprocess", () => {
  it("keeps the new transcript when the reprocess completes", async () => {
    const store = makeStore();
    const { pipeline, finish } = makePipeline(store);
    const reprocess = useTranscriptReprocess({ store, pipeline });

    const running = reprocess.run("record-a", manifest, { language: "en" });
    expect(reprocess.isReprocessing.value).toBe(true);
    store.segments = [{ id: "new", text: "better", speaker: "SPEAKER_1" }];
    store.processPhase = "complete";
    finish("complete");

    await expect(running).resolves.toEqual({
      status: "complete",
      error: null,
    });
    expect(reprocess.isReprocessing.value).toBe(false);
    expect(store.segments[0].id).toBe("new");
    expect(pipeline.reprocessFromManifest).toHaveBeenCalledWith(
      "record-a",
      manifest,
      { language: "en" },
    );
  });

  it("puts the original transcript back when the reprocess is cancelled", async () => {
    const store = makeStore();
    const { pipeline } = makePipeline(store);
    const reprocess = useTranscriptReprocess({ store, pipeline });

    const running = reprocess.run("record-a", manifest, {});
    reprocess.cancel();

    await expect(running).resolves.toEqual({
      status: "cancelled",
      error: null,
    });
    expect(store).toMatchObject({
      processPhase: "complete",
      segments: [{ id: "old", text: "original", speaker: "SPEAKER_0" }],
      speakerNames: { SPEAKER_0: "Alice" },
      speakerColors: { SPEAKER_0: "#ff0000" },
      addedSpeakerIds: ["SPEAKER_0"],
    });
    expect(reprocess.isReprocessing.value).toBe(false);
  });

  it("puts the original transcript back and reports the error when it fails", async () => {
    const store = makeStore();
    const { pipeline, finish } = makePipeline(store);
    const reprocess = useTranscriptReprocess({ store, pipeline });
    const error = { code: "X", message: "Model failed", recoverable: true };

    const running = reprocess.run("record-a", manifest, {});
    store.processPhase = "error";
    store.error = error;
    finish("failed");

    await expect(running).resolves.toEqual({ status: "failed", error });
    expect(store.processPhase).toBe("complete");
    expect(store.error).toBeNull();
    expect(store.segments[0].id).toBe("old");
  });

  it("leaves another recording alone when the reprocess is abandoned", async () => {
    const store = makeStore();
    const { pipeline } = makePipeline(store);
    const reprocess = useTranscriptReprocess({ store, pipeline });

    const running = reprocess.run("record-a", manifest, {});
    reprocess.abandon();
    expect(reprocess.isReprocessing.value).toBe(false);
    // Recording B is opened before the cancelled reprocess settles.
    store.segments = [{ id: "b", text: "other recording", speaker: null }];
    store.processPhase = "complete";

    await expect(running).resolves.toEqual({
      status: "abandoned",
      error: null,
    });
    expect(pipeline.cancel).toHaveBeenCalled();
    expect(store.segments).toEqual([
      { id: "b", text: "other recording", speaker: null },
    ]);
  });

  it("does nothing when cancelled or abandoned while idle", () => {
    const store = makeStore();
    const { pipeline } = makePipeline(store);
    const reprocess = useTranscriptReprocess({ store, pipeline });

    reprocess.cancel();
    reprocess.abandon();

    expect(pipeline.cancel).not.toHaveBeenCalled();
  });
});
