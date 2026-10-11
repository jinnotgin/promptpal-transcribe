import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NEW_NAME = "transcription";
const LEGACY_NAME = "promptpal-transcription";

/** Fresh module graph so the memoized name is resolved again per test. */
async function importFresh() {
  vi.resetModules();
  const dbModule = await import("./transcriptionDb.js");
  const modelCache = await import("./modelCache.js");
  return { ...dbModule, ...modelCache };
}

async function seedLegacyDatabase() {
  const legacy = new Dexie(LEGACY_NAME);
  legacy.version(4).stores({
    transcripts: "&id, createdAt",
    transcriptPayloads: "&id",
    transcriptAudioFragments:
      "[transcriptId+partIndex+fragmentIndex], transcriptId, [transcriptId+partIndex]",
    modelCache: "&cacheKey",
  });
  await legacy.open();
  await legacy.table("transcripts").put({
    id: "kept",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  legacy.close();
}

async function deleteBoth() {
  await Dexie.delete(NEW_NAME);
  await Dexie.delete(LEGACY_NAME);
}

describe("transcription database name", () => {
  beforeEach(deleteBoth);
  afterEach(async () => {
    vi.resetModules();
    await deleteBoth();
  });

  it("uses the neutral name in a browser without the legacy database", async () => {
    const { resolveTranscriptionDbName, getTranscriptionDb } =
      await importFresh();

    await expect(resolveTranscriptionDbName()).resolves.toBe(NEW_NAME);
    const db = await getTranscriptionDb();
    expect(db.name).toBe(NEW_NAME);
    await db.open();
    db.close();

    await expect(Dexie.exists(LEGACY_NAME)).resolves.toBe(false);
  });

  it("keeps using the legacy database when it already exists", async () => {
    await seedLegacyDatabase();
    const { getTranscriptionDb } = await importFresh();

    const db = await getTranscriptionDb();
    expect(db.name).toBe(LEGACY_NAME);
    expect(await db.transcripts.get("kept")).toMatchObject({ id: "kept" });
    db.close();

    await expect(Dexie.exists(NEW_NAME)).resolves.toBe(false);
  });

  it("stores cached models in the same database as transcript history", async () => {
    await seedLegacyDatabase();
    const { putCachedModel, getTranscriptionDb } = await importFresh();

    await putCachedModel("model-a", new ArrayBuffer(8), 8);

    const db = await getTranscriptionDb();
    expect(await db.modelCache.count()).toBeGreaterThan(0);
    db.close();
    await expect(Dexie.exists(NEW_NAME)).resolves.toBe(false);
  });

  it("does not let a model cache read create the legacy database for new users", async () => {
    const { hasCachedModel, resolveTranscriptionDbName } = await importFresh();

    await hasCachedModel("missing");

    await expect(resolveTranscriptionDbName()).resolves.toBe(NEW_NAME);
    await expect(Dexie.exists(LEGACY_NAME)).resolves.toBe(false);
  });
});
