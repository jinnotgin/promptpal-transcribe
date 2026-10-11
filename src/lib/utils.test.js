import { describe, expect, it } from "vitest";
import { formatVersion } from "./utils.js";

describe("formatVersion", () => {
  it("drops trailing zero minor and patch", () => {
    expect(formatVersion("2.0.0")).toBe("2");
  });

  it("drops a trailing zero patch", () => {
    expect(formatVersion("2.1.0")).toBe("2.1");
  });

  it("keeps a non-zero patch", () => {
    expect(formatVersion("2.1.3")).toBe("2.1.3");
    expect(formatVersion("2.0.1")).toBe("2.0.1");
  });
});
