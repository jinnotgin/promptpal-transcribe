import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptionDb } from "./transcriptionDb.js";

const DB_NAME = "transcription-live-source-test";

/** @param {'upload' | 'live'} source */
const manifest = (source) => ({
  version: 1,
  duration: 4,
  source,
  parts: [
    {
      index: 0,
      start: 0,
      end: 4,
      mimeType: "audio/mpeg",
      sizeBytes: 10,
      fragmentCount: 1,
    },
  ],
});

async function seedVersion4() {
  const db = new Dexie(DB_NAME);
  db.version(4).stores({
    transcripts: "&id, createdAt",
    transcriptPayloads: "&id",
    transcriptAudioFragments:
      "[transcriptId+partIndex+fragmentIndex], transcriptId, [transcriptId+partIndex]",
    modelCache: "&cacheKey",
  });
  await db.open();
  await db.table("transcripts").bulkPut([
    { id: "live-audio", fileName: "Team sync", isLiveRecording: false },
    {
      id: "named-upload",
      fileName: "Live Recording 2026.m4a",
      isLiveRecording: false,
    },
    { id: "legacy-live", fileName: "Live Recording 1/1/2026" },
    { id: "plain-upload", fileName: "Interview.mp3", isLiveRecording: false },
  ]);
  await db
    .table("transcriptPayloads")
    .bulkPut([
      { id: "live-audio", audioManifest: manifest("live") },
      { id: "named-upload", audioManifest: manifest("upload") },
      { id: "legacy-live" },
      { id: "plain-upload" },
    ]);
  db.close();
}

describe("transcription database live-source migration", () => {
  afterEach(async () => {
    await Dexie.delete(DB_NAME);
  });

  it("backfills the live flag from the audio source, not the file name", async () => {
    await seedVersion4();

    const db = createTranscriptionDb(DB_NAME);
    await db.open();
    const rows = await db.transcripts.toArray();
    db.close();

    const flags = Object.fromEntries(
      rows.map((row) => [row.id, row.isLiveRecording]),
    );
    expect(flags).toEqual({
      "live-audio": true,
      "named-upload": false,
      "legacy-live": true,
      "plain-upload": false,
    });
  });
});
