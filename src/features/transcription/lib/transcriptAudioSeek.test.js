import { describe, expect, it, vi } from "vitest";
import { createTranscriptAudioSeekCoordinator } from "./transcriptAudioSeek.js";

const manifest =
  /** @type {import('./transcriptAudioManifest.js').TranscriptAudioManifest} */ ({
    version: 1,
    duration: 15,
    source: "upload",
    parts: [
      {
        index: 0,
        start: 0,
        end: 5,
        mimeType: "audio/mpeg",
        sizeBytes: 1,
        fragmentCount: 1,
      },
      {
        index: 1,
        start: 5,
        end: 10,
        mimeType: "audio/mpeg",
        sizeBytes: 1,
        fragmentCount: 1,
      },
      {
        index: 2,
        start: 10,
        end: 15,
        mimeType: "audio/mpeg",
        sizeBytes: 1,
        fragmentCount: 1,
      },
    ],
  });

/**
 * @param {(partIndex: number, relativeTime: number, isCurrent: () => boolean) => Promise<boolean>} [loadPartOverride]
 * @param {import('./transcriptAudioManifest.js').TranscriptAudioManifest} [manifestOverride]
 */
function createHarness(loadPartOverride, manifestOverride = manifest) {
  let activePartIndex = 0;
  const playingStates = [];
  const audio = {
    paused: true,
    currentTime: 0,
    play: vi.fn(async () => {
      audio.paused = false;
      coordinator.handleMediaPlay();
    }),
  };
  const loadPart = vi.fn(
    loadPartOverride ||
      (async (partIndex, relativeTime, isCurrent) => {
        if (!isCurrent()) return false;
        audio.paused = true;
        coordinator.handleMediaPause();
        activePartIndex = partIndex;
        audio.currentTime = relativeTime;
        return true;
      }),
  );
  const coordinator = createTranscriptAudioSeekCoordinator({
    getAudio: () => audio,
    getManifest: () => manifestOverride,
    getActivePartIndex: () => activePartIndex,
    loadPart,
    onPlayingChange: (playing) => playingStates.push(playing),
  });

  return {
    audio,
    coordinator,
    loadPart,
    playingStates,
    getActivePartIndex: () => activePartIndex,
    setActivePartIndex: (value) => {
      activePartIndex = value;
    },
  };
}

describe("transcriptAudioSeek", () => {
  it("resumes a playing recording after a seek loads a different media part", async () => {
    const harness = createHarness();
    harness.audio.paused = false;
    harness.coordinator.handleMediaPlay();

    await harness.coordinator.seekAbsolute(7);

    expect(harness.loadPart).toHaveBeenCalledWith(1, 2, expect.any(Function));
    expect(harness.audio.play).toHaveBeenCalledOnce();
    expect(harness.audio.paused).toBe(false);
    expect(harness.playingStates.at(-1)).toBe(true);
  });

  it("keeps a paused recording paused after a cross-part seek", async () => {
    const harness = createHarness();
    harness.coordinator.handleMediaPause();

    await harness.coordinator.seekAbsolute(7);

    expect(harness.audio.play).not.toHaveBeenCalled();
    expect(harness.audio.paused).toBe(true);
    expect(harness.playingStates.at(-1)).toBe(false);
  });

  it("lets only the latest rapid seek replace the active media part", async () => {
    let releaseFirst = () => {};
    const firstLoad = new Promise((resolve) => {
      releaseFirst = () => resolve(undefined);
    });
    let harness;
    harness = createHarness(async (partIndex, relativeTime, isCurrent) => {
      if (partIndex === 1) await firstLoad;
      if (!isCurrent()) return false;
      harness.audio.paused = true;
      harness.coordinator.handleMediaPause();
      harness.setActivePartIndex(partIndex);
      harness.audio.currentTime = relativeTime;
      return true;
    });
    harness.audio.paused = false;
    harness.coordinator.handleMediaPlay();

    const firstSeek = harness.coordinator.seekAbsolute(7);
    const latestSeek = harness.coordinator.seekAbsolute(12);
    await latestSeek;
    releaseFirst();
    await firstSeek;

    expect(harness.getActivePartIndex()).toBe(2);
    expect(harness.audio.currentTime).toBe(2);
    expect(harness.audio.play).toHaveBeenCalledOnce();
  });

  it("cancels a pending part replacement when the latest seek returns to the active part", async () => {
    let releaseLoad = () => {};
    const pendingLoad = new Promise((resolve) => {
      releaseLoad = () => resolve(undefined);
    });
    let harness;
    harness = createHarness(async (partIndex, relativeTime, isCurrent) => {
      await pendingLoad;
      if (!isCurrent()) return false;
      harness.setActivePartIndex(partIndex);
      harness.audio.currentTime = relativeTime;
      return true;
    });

    const pendingSeek = harness.coordinator.seekAbsolute(7);
    await harness.coordinator.seekAbsolute(3);
    releaseLoad();
    await pendingSeek;

    expect(harness.getActivePartIndex()).toBe(0);
    expect(harness.audio.currentTime).toBe(3);
  });

  it("continues playing when normal playback reaches the next part", async () => {
    const harness = createHarness();

    await expect(harness.coordinator.continueToNextPart()).resolves.toBe(true);

    expect(harness.loadPart).toHaveBeenCalledWith(1, 0, expect.any(Function));
    expect(harness.audio.play).toHaveBeenCalledOnce();
    expect(harness.playingStates.at(-1)).toBe(true);
  });

  it("seeks within one logical audio part without replacing the media source", async () => {
    const continuousManifest = {
      ...manifest,
      duration: 15,
      parts: [{ ...manifest.parts[0], end: 15 }],
    };
    const harness = createHarness(undefined, continuousManifest);

    await expect(harness.coordinator.seekAbsolute(12)).resolves.toBe(true);
    await expect(harness.coordinator.continueToNextPart()).resolves.toBe(false);

    expect(harness.audio.currentTime).toBe(12);
    expect(harness.loadPart).not.toHaveBeenCalled();
    expect(harness.audio.play).not.toHaveBeenCalled();
  });
});
