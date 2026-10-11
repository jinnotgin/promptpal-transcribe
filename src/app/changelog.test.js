import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { formatVersion } from "@/lib/utils.js";
import { CHANGELOG, formatReleaseDate } from "./changelog.js";

describe("changelog", () => {
  it("leads with the current app version", () => {
    expect(CHANGELOG[0].version).toBe(formatVersion(pkg.version));
  });

  it("lists releases newest first, each with a title and changes", () => {
    expect(CHANGELOG.map((release) => release.version)).toEqual(["2", "1"]);
    for (const release of CHANGELOG) {
      expect(release.title).toBeTruthy();
      expect(release.changes.length).toBeGreaterThan(0);
      for (const change of release.changes) {
        expect(change.lead).toBeTruthy();
      }
    }
  });

  it("dates every release, newest first", () => {
    const dates = CHANGELOG.map((release) => release.date);
    for (const date of dates) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe("formatReleaseDate", () => {
  const now = new Date("2026-10-11T12:00:00Z");

  it("drops the year for releases from the current year", () => {
    expect(formatReleaseDate("2026-10-12", now)).toBe("12 Oct");
    expect(formatReleaseDate("2026-07-01", now)).toBe("1 Jul");
  });

  it("keeps the year for releases from other years", () => {
    expect(formatReleaseDate("2025-12-31", now)).toBe("31 Dec 2025");
  });
});
