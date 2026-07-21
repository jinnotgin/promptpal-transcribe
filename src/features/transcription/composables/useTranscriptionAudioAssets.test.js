import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  TRANSCRIPTION_DB_NAME,
} from "@/features/transcription/lib/transcriptionDb.js";
import { useTranscriptionAudioAssets } from "./useTranscriptionAudioAssets.js";

const resetDb = async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
};

function createLeaseStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe("useTranscriptionAudioAssets", () => {
  beforeEach(resetDb);
  afterEach(async () => {
    if (db.isOpen()) db.close();
    await Dexie.delete(TRANSCRIPTION_DB_NAME);
  });

  it("stores bounded fragments without rewriting earlier rows and reconstructs in order", async () => {
    const assets = useTranscriptionAudioAssets();
    await assets.stageFragment({
      transcriptId: "tx-1",
      partIndex: 0,
      fragmentIndex: 1,
      blob: new Blob(["two"], { type: "audio/webm" }),
    });
    await assets.stageFragment({
      transcriptId: "tx-1",
      partIndex: 0,
      fragmentIndex: 0,
      blob: new Blob(["one"], { type: "audio/webm" }),
    });

    expect(await db.transcriptAudioFragments.count()).toBe(2);
    expect(await db.transcriptAudioFragments.toArray()).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({ sizeBytes: expect.anything() }),
      ]),
    );
    const part = await assets.getPartBlob("tx-1", {
      index: 0,
      mimeType: "audio/webm",
      fragmentCount: 2,
    });
    expect(await part.text()).toBe("onetwo");
    expect(part.type).toBe("audio/webm");
  });

  it("applies position-aware writes to bounded pages without row byte-size metadata", async () => {
    const assets = useTranscriptionAudioAssets();
    const write = (position, data) =>
      assets.stagePositionedWrite({
        transcriptId: "mp3-export-pages",
        partIndex: 0,
        position,
        data: new Uint8Array(data),
        pageSize: 4,
        mimeType: "audio/mpeg",
      });

    await write(0, [1, 2, 3, 4]);
    await write(4, [5, 6]);
    await write(1, [9, 9]);

    expect(await assets.getStagedPartStats("mp3-export-pages", 0)).toEqual({
      sizeBytes: 6,
      fragmentCount: 2,
    });
    const rows = await db.transcriptAudioFragments
      .where("[transcriptId+partIndex]")
      .equals(["mp3-export-pages", 0])
      .sortBy("fragmentIndex");
    expect(rows.every((row) => !("sizeBytes" in row))).toBe(true);
    const blob = await assets.getPartBlob("mp3-export-pages", {
      index: 0,
      mimeType: "audio/mpeg",
      fragmentCount: 2,
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 9, 9, 4, 5, 6]),
    );
  });

  it("rolls back all staged fragments for a transcript", async () => {
    const assets = useTranscriptionAudioAssets();
    await assets.stageFragment({
      transcriptId: "tx-rollback",
      partIndex: 0,
      fragmentIndex: 0,
      blob: new Blob(["partial"]),
    });

    await assets.rollbackStaging("tx-rollback");
    expect(await db.transcriptAudioFragments.count()).toBe(0);
  });

  it("deletes one asset without touching another transcript", async () => {
    const assets = useTranscriptionAudioAssets();
    for (const transcriptId of ["keep", "drop"]) {
      await assets.stageFragment({
        transcriptId,
        partIndex: 0,
        fragmentIndex: 0,
        blob: new Blob([transcriptId]),
      });
    }

    await assets.deleteAsset("drop");
    expect(
      await db.transcriptAudioFragments
        .where("transcriptId")
        .equals("keep")
        .count(),
    ).toBe(1);
    expect(
      await db.transcriptAudioFragments
        .where("transcriptId")
        .equals("drop")
        .count(),
    ).toBe(0);
  });

  it("reconciles abandoned fragments while retaining committed manifest assets", async () => {
    const leaseStorage = createLeaseStorage();
    const assets = useTranscriptionAudioAssets({
      leaseStorage,
      now: () => 1_000_000,
    });
    for (const transcriptId of ["committed", "orphan"]) {
      await assets.stageFragment({
        transcriptId,
        partIndex: 0,
        fragmentIndex: 0,
        blob: new Blob([transcriptId]),
      });
    }
    await db.transcriptPayloads.put({
      id: "committed",
      audioManifest: { version: 1, duration: 1, source: "upload", parts: [] },
      audioMimeType: "audio/mpeg",
      audioFileName: "committed.mp3",
      segments: [],
      speakerNames: {},
      speakerColors: {},
      addedSpeakerIds: [],
      waveformSamples: [],
    });

    await assets.reconcileOrphans();
    expect(
      await db.transcriptAudioFragments
        .where("transcriptId")
        .equals("committed")
        .count(),
    ).toBe(1);
    expect(
      await db.transcriptAudioFragments
        .where("transcriptId")
        .equals("orphan")
        .count(),
    ).toBe(0);
  });

  it("retains a current cross-tab staging lease and reconciles from keys without loading blobs", async () => {
    const leaseStorage = createLeaseStorage();
    const owner = useTranscriptionAudioAssets({
      leaseStorage,
      now: () => 1_000_000,
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await owner.beginStaging("active-in-another-tab");
    await owner.stageFragment({
      transcriptId: "active-in-another-tab",
      partIndex: 0,
      fragmentIndex: 0,
      blob: new Blob(["active"]),
    });

    const toArray = vi.spyOn(db.transcriptAudioFragments, "toArray");
    const reconciler = useTranscriptionAudioAssets({
      leaseStorage,
      now: () => 1_000_001,
    });
    await reconciler.reconcileOrphans();

    expect(toArray).not.toHaveBeenCalled();
    expect(
      await db.transcriptAudioFragments
        .where("transcriptId")
        .equals("active-in-another-tab")
        .count(),
    ).toBe(1);
    await owner.rollbackStaging("active-in-another-tab");
  });

  it("removes fragments after their staging lease becomes stale", async () => {
    const leaseStorage = createLeaseStorage();
    const owner = useTranscriptionAudioAssets({
      leaseStorage,
      now: () => 1_000,
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await owner.beginStaging("stale-session");
    await owner.stageFragment({
      transcriptId: "stale-session",
      partIndex: 0,
      fragmentIndex: 0,
      blob: new Blob(["stale"]),
    });

    await useTranscriptionAudioAssets({
      leaseStorage,
      now: () => 1_000 + 5 * 60_000 + 1,
    }).reconcileOrphans();

    expect(
      await db.transcriptAudioFragments
        .where("transcriptId")
        .equals("stale-session")
        .count(),
    ).toBe(0);
    await owner.finishStaging("stale-session");
  });

  it("keeps the transcription database on schema version 4", () => {
    expect(db.verno).toBe(4);
  });
});
