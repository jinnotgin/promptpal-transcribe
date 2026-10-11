import { describe, expect, it } from "vitest";
import { readOnnxMetadata } from "./onnxMetadata.js";

/** @param {number} value */
function varint(value) {
  const bytes = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return bytes;
}

/**
 * @param {number} field
 * @param {number[]} payload
 */
function lengthDelimited(field, payload) {
  return [...varint((field << 3) | 2), ...varint(payload.length), ...payload];
}

/** @param {string} text */
function utf8(text) {
  return Array.from(new TextEncoder().encode(text));
}

/**
 * @param {string} key
 * @param {string} value
 */
function entry(key, value) {
  return lengthDelimited(14, [
    ...lengthDelimited(1, utf8(key)),
    ...lengthDelimited(2, utf8(value)),
  ]);
}

describe("readOnnxMetadata", () => {
  it("reads metadata_props and skips other ModelProto fields", () => {
    const bytes = Uint8Array.from([
      ...varint((1 << 3) | 0), // ir_version
      ...varint(8),
      ...lengthDelimited(2, utf8("pytorch")), // producer_name
      ...lengthDelimited(7, new Array(300).fill(7)), // graph
      ...entry("lfr_window_size", "7"),
      ...entry("comment", "中文"),
    ]);
    expect(readOnnxMetadata(bytes.buffer)).toEqual({
      lfr_window_size: "7",
      comment: "中文",
    });
  });

  it("returns an empty record when the model has no metadata", () => {
    const irVersionOnly = Uint8Array.from([...varint((1 << 3) | 0), 8]);
    expect(readOnnxMetadata(irVersionOnly.buffer)).toEqual({});
  });
});
