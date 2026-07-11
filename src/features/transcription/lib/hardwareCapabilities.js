/**
 * @typedef {'webgpu' | 'wasm'} RuntimeBackend
 * @typedef {'fp16' | 'int8'} ModelVersion
 * @typedef {'none' | 'browser' | 'memory' | 'hardware'} RuntimeAdvisory
 * @typedef {{ supported: boolean, backend: RuntimeBackend, version: ModelVersion, webgpuAvailable: boolean, reason: string, advisory: RuntimeAdvisory }} HardwareCapability
 */

const GB = 0x40000000;

/**
 * Check browser/hardware capability for local ASR.
 * @returns {Promise<HardwareCapability>}
 */
export async function checkHardwareCapabilities() {
  const userAgent = navigator.userAgent || "";
  const limitedBrowser = isSafari(userAgent) || isFirefox(userAgent);
  const mobile = isMobileDevice(userAgent);
  const nav =
    /** @type {Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }} */ (
      navigator
    );

  if (mobile) {
    return wasmFallback(
      "Mobile devices use WASM/int8 to avoid browser memory crashes.",
      false,
      "memory",
    );
  }

  if (!nav.gpu) {
    return wasmFallback(
      "WebGPU is not available in this browser.",
      false,
      "browser",
    );
  }

  if (limitedBrowser) {
    return wasmFallback(
      "This browser uses WASM/int8 because large WebGPU models are less reliable here.",
      true,
      "browser",
    );
  }

  try {
    const adapter =
      /** @type {{ isFallbackAdapter?: boolean, limits?: Record<string, number>, features?: Set<string> }} */ (
        await nav.gpu.requestAdapter()
      );

    if (!adapter) {
      return wasmFallback(
        "WebGPU adapter request returned no adapter.",
        false,
        "hardware",
      );
    }

    if (adapter.isFallbackAdapter) {
      return wasmFallback(
        "Only a fallback WebGPU adapter is available.",
        true,
        "hardware",
      );
    }

    const maxBuffer = adapter.limits?.maxBufferSize || 0;
    const maxStorage = adapter.limits?.maxStorageBufferBindingSize || 0;
    const hasEnoughBuffers = maxBuffer >= 1.3 * GB && maxStorage >= 1.3 * GB;
    const hasEnoughCores = (navigator.hardwareConcurrency || 4) >= 4;

    if (!hasEnoughBuffers) {
      return wasmFallback(
        `WebGPU buffer limits are too low for fp16 ASR (max buffer ${(maxBuffer / GB).toFixed(2)} GB).`,
        true,
        "memory",
      );
    }

    if (!hasEnoughCores) {
      return wasmFallback(
        "CPU core count is low for reliable local fp16 ASR.",
        true,
        "hardware",
      );
    }

    const f16Note = adapter.features?.has("shader-f16")
      ? ""
      : " Native shader-f16 is unavailable, so performance may be lower.";

    return {
      supported: true,
      backend: "webgpu",
      version: "fp16",
      webgpuAvailable: true,
      reason:
        `WebGPU fp16 is available with adequate buffer limits.${f16Note}`.trim(),
      advisory: "none",
    };
  } catch (err) {
    return wasmFallback(
      `WebGPU adapter check failed: ${err?.message || "unknown error"}.`,
      true,
      "hardware",
    );
  }
}

/**
 * @param {string} reason
 * @param {boolean} webgpuAvailable
 * @param {RuntimeAdvisory} advisory
 * @returns {HardwareCapability}
 */
function wasmFallback(reason, webgpuAvailable, advisory) {
  return {
    supported: typeof WebAssembly !== "undefined",
    backend: "wasm",
    version: "int8",
    webgpuAvailable,
    reason: `${reason} Falling back to WASM/int8.`,
    advisory,
  };
}

/**
 * @param {string} userAgent
 */
function isSafari(userAgent) {
  return (
    /AppleWebKit/i.test(userAgent) &&
    !/Chrome|Chromium|Android/i.test(userAgent)
  );
}

/**
 * @param {string} userAgent
 */
function isFirefox(userAgent) {
  return userAgent.toLowerCase().includes("firefox");
}

/**
 * @param {string} userAgent
 */
function isMobileDevice(userAgent) {
  return (
    /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      userAgent,
    ) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Detect a real Google Chrome (or Chromium) browser. Excludes Edge, Opera,
 * Brave's "Brave-Browser" identifier, Safari, and Firefox so we can show a
 * single "use Chrome for best performance" advisory.
 * @returns {boolean}
 */
export function isChromeBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (!/Chrome\//i.test(ua)) return false;
  if (/Edg\/|OPR\/|Brave\//i.test(ua)) return false;
  if (/Firefox\//i.test(ua)) return false;
  return true;
}
