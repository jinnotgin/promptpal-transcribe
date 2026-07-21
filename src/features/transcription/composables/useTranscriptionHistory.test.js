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

  it("loads the full text record and speakers when opened", async () => {
    const history = useTranscriptionHistory();
    const id = await history.saveTranscript(makeEntry());

    const full = await history.loadTranscript(id);
    expect(full).not.toBeNull();
    expect(full.segments).toHaveLength(2);
    expect(full.speakerNames).toEqual({
      "Speaker 1": "Alice",
      "Speaker 2": "Bob",
    });
    expect("audioBlob" in full).toBe(false);
  });

  it("persists manifest metadata without duplicating new audio in the payload", async () => {
    const history = useTranscriptionHistory();
    const id = "manifest-record";
    const audioManifest =
      /** @type {import('@/features/transcription/lib/transcriptAudioManifest.js').TranscriptAudioManifest} */ ({
        version: 1,
        duration: 12,
        source: "upload",
        parts: [
          {
            index: 0,
            start: 0,
            end: 12,
            mimeType: "audio/mpeg",
            sizeBytes: 5,
            fragmentCount: 1,
          },
        ],
      });
    await db.transcriptAudioFragments.put({
      transcriptId: id,
      partIndex: 0,
      fragmentIndex: 0,
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
    });

    await history.saveTranscript(makeEntry({ id, audioManifest }), {
      finalizeAudio: true,
    });
    const full = await history.loadTranscript(id);
    expect("audioBlob" in full).toBe(false);
    expect(full.audioManifest).toEqual(audioManifest);

    await history.deleteTranscript(id);
    expect(
      await db.transcriptAudioFragments
        .where("transcriptId")
        .equals(id)
        .count(),
    ).toBe(0);
  });

  it("refuses to finalize a manifest whose fragment count or byte total is incomplete", async () => {
    const history = useTranscriptionHistory();
    const id = "incomplete-manifest";
    const audioManifest = {
      version: 1,
      duration: 2,
      source: "live",
      parts: [
        {
          index: 0,
          start: 0,
          end: 2,
          mimeType: "audio/webm",
          sizeBytes: 20,
          fragmentCount: 2,
        },
      ],
    };
    await db.transcriptAudioFragments.put({
      transcriptId: id,
      partIndex: 0,
      fragmentIndex: 0,
      blob: new Blob(["short"]),
    });

    await expect(
      history.saveTranscript(makeEntry({ id, audioManifest }), {
        finalizeAudio: true,
      }),
    ).rejects.toThrow(/incomplete|byte size/i);
    expect(await db.transcripts.get(id)).toBeUndefined();
    expect(await db.transcriptPayloads.get(id)).toBeUndefined();
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

    // Opening the shared instance triggers the upgrade chain through v4.
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
    expect("audioBlob" in full).toBe(false);

    // The legacy primary-key row must be gone.
    expect(await db.transcripts.get("latest")).toBeUndefined();
  });

  it("upgrades v2 Blob audio to text-only history without deleting transcript content", async () => {
    if (db.isOpen()) db.close();
    await Dexie.delete(TRANSCRIPTION_DB_NAME);

    const legacyDb = new Dexie(TRANSCRIPTION_DB_NAME);
    legacyDb.version(2).stores({
      transcripts: "&id, createdAt",
      transcriptPayloads: "&id",
      modelCache: "&cacheKey",
    });
    await legacyDb.open();
    await legacyDb.table("transcripts").put({
      id: "legacy-v2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      fileName: "legacy-v2.mp3",
      fileSize: 999,
      fileDuration: 42,
      isLiveRecording: true,
      hasReprocessedLiveRecording: false,
      speakerCount: 2,
      segmentCount: 2,
      preview: "legacy words",
    });
    await legacyDb.table("transcriptPayloads").put({
      id: "legacy-v2",
      audioBlob: new Blob(["legacy-audio"], { type: "audio/mpeg" }),
      audioMimeType: "audio/mpeg",
      audioFileName: "legacy-v2.mp3",
      segments: makeSegments("legacy words"),
      speakerNames: { "Speaker 1": "Legacy" },
      speakerColors: {},
      addedSpeakerIds: [],
      waveformSamples: [],
    });
    legacyDb.close();

    await db.open();

    const full = await useTranscriptionHistory().loadTranscript("legacy-v2");
    expect(full.segments[0].text).toBe("legacy words");
    expect(full.speakerNames["Speaker 1"]).toBe("Legacy");
    expect("audioBlob" in full).toBe(false);
    expect(db.verno).toBe(4);
  });
});
