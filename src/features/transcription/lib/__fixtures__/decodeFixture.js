/**
 * @param {string} base64
 * @returns {Float32Array}
 */
export function decodeFloat32(base64) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Float32Array(bytes.buffer);
}
