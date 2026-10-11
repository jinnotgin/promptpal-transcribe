import { describe, expect, it } from "vitest";
import {
  endsSentence,
  isUnspacedScript,
  joinWordTexts,
  splitTextIntoWords,
} from "./wordText.js";

describe("splitTextIntoWords", () => {
  it("splits Latin text on whitespace", () => {
    expect(splitTextIntoWords(" Hello  there. ")).toEqual(["Hello", "there."]);
  });

  it("splits Chinese into characters, keeping punctuation and Latin runs", () => {
    expect(splitTextIntoWords("我们用machine learning做，好。")).toEqual([
      "我",
      "们",
      "用",
      "machine",
      "learning",
      "做，",
      "好。",
    ]);
  });
});

describe("endsSentence", () => {
  it("recognises Latin and CJK sentence-final punctuation", () => {
    expect(endsSentence("done.")).toBe(true);
    expect(endsSentence("好。")).toBe(true);
    expect(endsSentence("吗？")).toBe(true);
    expect(endsSentence("对！")).toBe(true);
    expect(endsSentence("做，")).toBe(false);
    expect(endsSentence("word")).toBe(false);
  });
});

describe("joinWordTexts", () => {
  it("separates English words with spaces", () => {
    expect(joinWordTexts(["The", "tribal", "chieftain."])).toBe(
      "The tribal chieftain.",
    );
  });

  it("joins Chinese characters without spaces", () => {
    expect(joinWordTexts(["开", "饭", "时", "间", "9", "点", "。"])).toBe(
      "开饭时间9点。",
    );
  });

  it("keeps spaces between English words inside mixed Chinese speech", () => {
    expect(joinWordTexts(["我", "们", "用", "machine", "learning", "做"])).toBe(
      "我们用machine learning做",
    );
  });

  it("does not put a space before punctuation", () => {
    expect(joinWordTexts(["Hello", ",", "world", "!"])).toBe("Hello, world!");
  });

  it("skips empty words", () => {
    expect(joinWordTexts(["a", "", " ", "b"])).toBe("a b");
  });
});

describe("isUnspacedScript", () => {
  it("covers Han and Japanese kana but not Hangul or Latin", () => {
    expect(isUnspacedScript("中")).toBe(true);
    expect(isUnspacedScript("う")).toBe(true);
    expect(isUnspacedScript("カ")).toBe(true);
    expect(isUnspacedScript("조")).toBe(false);
    expect(isUnspacedScript("a")).toBe(false);
  });
});
