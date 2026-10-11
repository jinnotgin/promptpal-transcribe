import { describe, expect, it } from "vitest";
import {
  alignmentJobForRegion,
  jobsInWindow,
  replaceAlignedRows,
} from "./alignmentJobs.js";

/** @param {string} id @param {string} text @param {number} start */
const row = (id, text, start, speaker = "Speaker A") => ({
  id,
  text,
  start,
  end: start + 1,
  speaker,
  words: [],
});

describe("alignmentJobForRegion", () => {
  it("joins the region's sentences without spaces between Chinese", () => {
    expect(
      alignmentJobForRegion({ start: 4, end: 9 }, [
        row("a", "大家好。", 4),
        row("b", "Good morning.", 5),
        row("c", "今天开会。", 6),
      ]),
    ).toEqual({
      start: 4,
      end: 9,
      speaker: "Speaker A",
      text: "大家好。Good morning.今天开会。",
      rowIds: ["a", "b", "c"],
    });
  });

  it("returns null for a region without text", () => {
    expect(alignmentJobForRegion({ start: 0, end: 1 }, [])).toBeNull();
  });
});

describe("replaceAlignedRows", () => {
  it("swaps aligned regions and keeps the rest in time order", () => {
    const rows = [
      row("a", "一。", 0),
      row("b", "二。", 2),
      row("c", "三。", 4),
    ];
    const job = {
      start: 2,
      end: 3,
      speaker: null,
      text: "二。",
      rowIds: ["b"],
    };
    let next = 0;
    const result = replaceAlignedRows(
      rows,
      [
        {
          job,
          segments: [
            {
              text: "二。",
              start: 2.2,
              end: 2.6,
              speaker: "Speaker A",
              words: [],
            },
          ],
        },
      ],
      () => `new-${next++}`,
    );
    expect(result.map((r) => [r.id, r.start])).toEqual([
      ["a", 0],
      ["new-0", 2.2],
      ["c", 4],
    ]);
  });
});

describe("jobsInWindow", () => {
  it("picks jobs starting in the committed range", () => {
    const job = (/** @type {number} */ start) => ({
      start,
      end: start + 1,
      speaker: null,
      text: "x",
      rowIds: [],
    });
    expect(
      jobsInWindow([job(70), job(10), job(59.9), job(60)], 10, 60).map(
        (j) => j.start,
      ),
    ).toEqual([10, 59.9]);
  });
});
