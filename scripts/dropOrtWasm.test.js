import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeOrtWasm } from "./dropOrtWasm.js";

describe("removeOrtWasm", () => {
  /** @type {string} */
  let outDir;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "drop-ort-wasm-"));
    fs.mkdirSync(path.join(outDir, "assets"));
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  /** @param {string} name */
  function writeAsset(name) {
    fs.writeFileSync(path.join(outDir, "assets", name), "x");
  }

  it("removes onnxruntime-web WASM binaries and keeps other assets", () => {
    writeAsset("ort-wasm-simd-threaded.jsep-MDYUKy93.wasm");
    writeAsset("ort-wasm-simd-threaded.asyncify-D5D0fo7z.wasm");
    writeAsset("ten_vad-DpmpZqYN.wasm");
    writeAsset("ort.bundle.min-BlwlTqvY.js");

    const removed = removeOrtWasm(outDir);

    expect(removed.sort()).toEqual([
      "ort-wasm-simd-threaded.asyncify-D5D0fo7z.wasm",
      "ort-wasm-simd-threaded.jsep-MDYUKy93.wasm",
    ]);
    expect(fs.readdirSync(path.join(outDir, "assets")).sort()).toEqual([
      "ort.bundle.min-BlwlTqvY.js",
      "ten_vad-DpmpZqYN.wasm",
    ]);
  });

  it("does nothing when there is no assets folder", () => {
    fs.rmSync(path.join(outDir, "assets"), { recursive: true });

    expect(removeOrtWasm(outDir)).toEqual([]);
  });
});
