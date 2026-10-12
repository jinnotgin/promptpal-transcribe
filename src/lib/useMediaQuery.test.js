import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { useMediaQuery } from "./useMediaQuery.js";

function stubMatchMedia(initialMatches) {
  const listeners = new Set();
  const mediaQueryList = {
    matches: initialMatches,
    addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener) => listeners.delete(listener)),
  };
  vi.stubGlobal("window", { matchMedia: vi.fn(() => mediaQueryList) });
  return {
    mediaQueryList,
    listeners,
    change(matches) {
      mediaQueryList.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };
}

describe("useMediaQuery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with the query's current match", () => {
    stubMatchMedia(true);
    const scope = effectScope();
    const matches = scope.run(() => useMediaQuery("(max-width: 639px)"));

    expect(matches.value).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 639px)");
    scope.stop();
  });

  it("follows changes to the query", () => {
    const media = stubMatchMedia(false);
    const scope = effectScope();
    const matches = scope.run(() => useMediaQuery("(max-width: 639px)"));

    media.change(true);
    expect(matches.value).toBe(true);
    media.change(false);
    expect(matches.value).toBe(false);
    scope.stop();
  });

  it("stops listening when its scope is disposed", () => {
    const media = stubMatchMedia(false);
    const scope = effectScope();
    scope.run(() => useMediaQuery("(max-width: 639px)"));

    scope.stop();
    expect(media.listeners.size).toBe(0);
  });

  it("does not match without a browser window", () => {
    const scope = effectScope();
    const matches = scope.run(() => useMediaQuery("(max-width: 639px)"));

    expect(matches.value).toBe(false);
    scope.stop();
  });
});
