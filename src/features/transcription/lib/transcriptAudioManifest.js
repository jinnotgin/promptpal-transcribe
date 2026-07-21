/**
 * @typedef {'upload' | 'live'} TranscriptAudioSource
 * @typedef {{
 *   index: number,
 *   start: number,
 *   end: number,
 *   mimeType: string,
 *   sizeBytes: number,
 *   fragmentCount: number,
 * }} TranscriptAudioPart
 * @typedef {{
 *   version: 1,
 *   duration: number,
 *   source: TranscriptAudioSource,
 *   parts: TranscriptAudioPart[],
 * }} TranscriptAudioManifest
 */

const TIME_EPSILON_SECONDS = 0.001;

/**
 * Validate untrusted persisted media metadata and return a clone with stable
 * primitive values. Audio formats are explicit and never inferred from a file
 * name.
 * @param {unknown} value
 * @returns {TranscriptAudioManifest}
 */
export function normalizeTranscriptAudioManifest(value) {
  if (!value || typeof value !== "object")
    throw new Error("Audio manifest is required");
  const input = /** @type {Record<string, any>} */ (value);
  if (Number(input.version) !== 1)
    throw new Error("Unsupported audio manifest version");
  if (input.source !== "upload" && input.source !== "live") {
    throw new Error("Audio manifest source must be upload or live");
  }
  const duration = finiteNonNegative(input.duration, "Audio manifest duration");
  if (duration <= 0)
    throw new Error("Audio manifest duration must be positive");
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    throw new Error("Audio manifest must contain at least one part");
  }

  let previousEnd = 0;
  const parts = input.parts.map((rawPart, position) => {
    const part = rawPart && typeof rawPart === "object" ? rawPart : {};
    const index = finiteInteger(part.index, "Audio part index");
    if (index !== position)
      throw new Error("Audio part indexes must be contiguous");
    const start = finiteNonNegative(part.start, "Audio part start");
    const end = finiteNonNegative(part.end, "Audio part end");
    if (end <= start) throw new Error("Audio part end must follow its start");
    if (start + TIME_EPSILON_SECONDS < previousEnd) {
      throw new Error("Audio parts must not overlap");
    }
    if (end > duration + TIME_EPSILON_SECONDS) {
      throw new Error("Audio part exceeds manifest duration");
    }
    const mimeType = String(part.mimeType || "")
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith("audio/"))
      throw new Error("Audio part MIME type is required");
    const sizeBytes = finiteInteger(part.sizeBytes, "Audio part byte size");
    if (sizeBytes <= 0)
      throw new Error("Audio part byte size must be positive");
    const fragmentCount = finiteInteger(
      part.fragmentCount,
      "Audio part fragment count",
    );
    if (fragmentCount <= 0)
      throw new Error("Audio part fragment count must be positive");

    previousEnd = end;
    return {
      index,
      start,
      end,
      mimeType,
      sizeBytes,
      fragmentCount,
    };
  });

  return { version: 1, duration, source: input.source, parts };
}

/**
 * Convert an absolute transcript time to a logical part and part-relative time.
 * Exact boundaries resolve to the following part so content is not replayed.
 * @param {TranscriptAudioManifest} manifest
 * @param {number} absoluteTime
 */
export function findAudioPartAtTime(manifest, absoluteTime) {
  const normalized = normalizeTranscriptAudioManifest(manifest);
  const time = Math.min(
    normalized.duration,
    Math.max(0, Number(absoluteTime) || 0),
  );
  let part = normalized.parts.find(
    (candidate, index) =>
      time >= candidate.start &&
      (time < candidate.end || index === normalized.parts.length - 1),
  );
  if (!part) {
    part = normalized.parts.reduce((closest, candidate) =>
      candidate.start <= time ? candidate : closest,
    );
  }
  return {
    part,
    partIndex: part.index,
    relativeTime: Math.min(
      part.end - part.start,
      Math.max(0, time - part.start),
    ),
    absoluteTime: time,
  };
}

/** @param {unknown} value @param {string} label */
function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new Error(`${label} must be non-negative`);
  return number;
}

/** @param {unknown} value @param {string} label */
function finiteInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be an integer`);
  return number;
}
