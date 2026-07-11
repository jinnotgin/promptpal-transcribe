import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  db,
  TRANSCRIPTION_DB_NAME,
} from "@/features/transcription/lib/transcriptionDb.js";
import { useTranscriptionHistory } from "./useTranscriptionHistory.js";

const makeSegments = (text = "hello there") => [
  { id: "seg-1", start: 0, end: 1, text, speaker: "Speaker 1" },
  {
    id: "seg-2",
    start: 1,
    end: 2,
    text: "general kenobi",
    speaker: "Speaker 2",
  },
];

const makeEntry = (overrides = {}) => ({
  fileName: "memo.mp3",
  fileSize: 2048,
  fileDuration: 12,
  isLiveRecording: false,
  audioBlob: new Blob(["audio-bytes"], { type: "audio/mpeg" }),
  audioMimeType: "audio/mpeg",
  audioFileName: "memo.mp3",
  segments: makeSegments(),
  speakerNames: { "Speaker 1": "Alice", "Speaker 2": "Bob" },
  speakerColors: { "Speaker 1": "#111111" },
  addedSpeakerIds: [],
  ...overrides,
});

const resetDb = async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
};

describe("useTranscriptionHistory", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await Dexie.delete(TRANSCRIPTION_DB_NAME);
  });

  it("saves a transcript and lists it as lightweight metadata (no audio blob)", async () => {
    const history = useTranscriptionHistory();
    const id = await history.saveTranscript(makeEntry());

    const summaries = await history.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(id);
    expect(summaries[0].fileName).toBe("memo.mp3");
    expect(summaries[0].speakerCount).toBe(2);
    expect(summaries[0].segmentCount).toBe(2);
    expect(summaries[0].preview).toContain("hello there");
    // metadata table must not carry the heavy payload
    expect("audioBlob" in summaries[0]).toBe(false);
    expect("segments" in summaries[0]).toBe(false);
  });

  it("loads the full record with audio and speakers when opened", async () => {
    const history = useTranscriptionHistory();
    const id = await history.saveTranscript(makeEntry());

    const full = await history.loadTranscript(id);
    expect(full).not.toBeNull();
    expect(full.segments).toHaveLength(2);
    expect(full.speakerNames).toEqual({
      "Speaker 1": "Alice",
      "Speaker 2": "Bob",
    });
    expect(full.audioBlob).toBeInstanceOf(Blob);
    expect(full.audioBlob.size).toBeGreaterThan(0);
  });

  it("returns null when loading a missing record", async () => {
    const history = useTranscriptionHistory();
    expect(await history.loadTranscript("nope")).toBeNull();
  });

  it("keeps multiple distinct records", async () => {
    const history = useTranscriptionHistory();
    const first = await history.saveTranscript(
      makeEntry({ fileName: "one.mp3" }),
    );
    const second = await history.saveTranscript(
      makeEntry({ fileName: "two.mp3" }),
    );

    expect(first).not.toBe(second);
    const summaries = await history.listSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.fileName).sort()).toEqual([
      "one.mp3",
      "two.mp3",
    ]);
  });

  it("updates an existing record in place and preserves createdAt", async () => {
    const history = useTranscriptionHistory();
    const id = await history.saveTranscript(makeEntry());
    const created = (await history.loadTranscript(id)).createdAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await history.saveTranscript(
      makeEntry({ id, speakerNames: { "Speaker 1": "Renamed" } }),
    );

    const summaries = await history.listSummaries();
    expect(summaries).toHaveLength(1);
    const reloaded = await history.loadTranscript(id);
    expect(reloaded.createdAt).toBe(created);
    expect(reloaded.updatedAt).not.toBe(created);
    expect(reloaded.speakerNames["Speaker 1"]).toBe("Renamed");
  });

  it("refuses to save a transcript with no segments", async () => {
    const history = useTranscriptionHistory();
    await expect(
      history.saveTranscript(makeEntry({ segments: [] })),
    ).rejects.toThrow();
  });

  it("deletes a single record without touching the others", async () => {
    const history = useTranscriptionHistory();
    const keep = await history.saveTranscript(
      makeEntry({ fileName: "keep.mp3" }),
    );
    const drop = await history.saveTranscript(
      makeEntry({ fileName: "drop.mp3" }),
    );

    await history.deleteTranscript(drop);

    const summaries = await history.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(keep);
    expect(await history.loadTranscript(drop)).toBeNull();
    expect(await db.transcriptPayloads.get(drop)).toBeUndefined();
  });

  it("deletes all records", async () => {
    const history = useTranscriptionHistory();
    await history.saveTranscript(makeEntry({ fileName: "a.mp3" }));
    await history.saveTranscript(makeEntry({ fileName: "b.mp3" }));

    await history.deleteAll();

    expect(await history.listSummaries()).toHaveLength(0);
    expect(await db.transcriptPayloads.count()).toBe(0);
  });

  it("migrates a legacy v1 'latest' record into the multi-record store", async () => {
    // Tear down the v2 db and seed an on-disk v1 database with the old schema.
    if (db.isOpen()) db.close();
    await Dexie.delete(TRANSCRIPTION_DB_NAME);

    const legacyDb = new Dexie(TRANSCRIPTION_DB_NAME);
    legacyDb.version(1).stores({
      transcripts: "&id, createdAt, fileName",
      modelCache: "&cacheKey",
    });
    await legacyDb.open();
    await legacyDb.table("transcripts").put({
      id: "latest",
      createdAt: "2026-01-01T00:00:00.000Z",
      fileName: "legacy.mp3",
      fileSize: 999,
      fileDuration: 42,
      audioBlob: new Blob(["legacy-audio"], { type: "audio/mpeg" }),
      audioMimeType: "audio/mpeg",
      audioFileName: "legacy.mp3",
      isLiveRecording: false,
      segments: makeSegments("legacy words"),
      speakerNames: { "Speaker 1": "Legacy" },
      speakerColors: {},
      addedSpeakerIds: [],
    });
    legacyDb.close();

    // Opening the shared (v1+v2) instance triggers the upgrade.
    await db.open();

    const history = useTranscriptionHistory();
    const summaries = await history.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].fileName).toBe("legacy.mp3");
    expect(summaries[0].id).not.toBe("latest");
    expect(summaries[0].fileDuration).toBe(42);

    const full = await history.loadTranscript(summaries[0].id);
    expect(full.segments).toHaveLength(2);
    expect(full.segments[0].text).toBe("legacy words");
    expect(full.speakerNames["Speaker 1"]).toBe("Legacy");
    expect(full.audioBlob.size).toBeGreaterThan(0);

    // The legacy primary-key row must be gone.
    expect(await db.transcripts.get("latest")).toBeUndefined();
  });
});
