/**
 * Reads `metadata_props` from a serialized ONNX ModelProto. onnxruntime-web
 * does not expose custom metadata, and sherpa-onnx exports keep their
 * feature settings there. Only top-level fields are walked; the graph and
 * its weights are skipped by length, so this is cheap on large models.
 */

const METADATA_PROPS_FIELD = 14;
const KEY_FIELD = 1;
const VALUE_FIELD = 2;

/**
 * @param {ArrayBuffer} buffer
 * @returns {Record<string, string>}
 */
export function readOnnxMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  /** @type {Record<string, string>} */
  const metadata = {};
  forEachField(bytes, 0, bytes.length, (field, start, end) => {
    if (field !== METADATA_PROPS_FIELD) return;
    let key = "";
    let value = "";
    forEachField(bytes, start, end, (inner, innerStart, innerEnd) => {
      const text = decoder.decode(bytes.subarray(innerStart, innerEnd));
      if (inner === KEY_FIELD) key = text;
      else if (inner === VALUE_FIELD) value = text;
    });
    if (key) metadata[key] = value;
  });
  return metadata;
}

/**
 * Calls `visit` for each length-delimited field in [start, end).
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {(field: number, start: number, end: number) => void} visit
 */
function forEachField(bytes, start, end, visit) {
  let position = start;
  while (position < end) {
    const [tag, afterTag] = readVarint(bytes, position);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    position = afterTag;
    if (wireType === 0) {
      position = readVarint(bytes, position)[1];
    } else if (wireType === 1) {
      position += 8;
    } else if (wireType === 5) {
      position += 4;
    } else if (wireType === 2) {
      const [length, afterLength] = readVarint(bytes, position);
      visit(field, afterLength, afterLength + length);
      position = afterLength + length;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} position
 * @returns {[number, number]} value and the position after it
 */
function readVarint(bytes, position) {
  let value = 0;
  let multiplier = 1;
  let index = position;
  for (;;) {
    if (index >= bytes.length) throw new Error("Truncated ONNX model");
    const byte = bytes[index];
    index += 1;
    value += (byte & 0x7f) * multiplier;
    if (byte < 0x80) return [value, index];
    multiplier *= 128;
  }
}
