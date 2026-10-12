/**
 * Plain-language labels for the "On-device" info panel.
 */

/**
 * Name the hardware transcription runs on. A manual choice wins over the
 * runtime detected in auto mode.
 * @param {string} executionEnv "auto" | "webgpu" | "wasm"
 * @param {string} effectiveRuntime "webgpu" | "wasm"
 */
export function describeRuntime(executionEnv, effectiveRuntime) {
  const runtime = executionEnv === "auto" ? effectiveRuntime : executionEnv;
  return runtime === "webgpu"
    ? "graphics card (WebGPU)"
    : "processor (WebAssembly)";
}

/**
 * @param {{ cached: boolean, progress: number, indeterminate?: boolean }} model
 * @returns {{ state: "ready" | "downloading" | "missing", label: string }}
 */
export function describeModelStatus({ cached, progress, indeterminate }) {
  // The status icon already shows a ready model.
  if (cached) return { state: "ready", label: "" };
  // "Loading" covers both a fresh download and a read from the cache.
  if (indeterminate) return { state: "downloading", label: "Loading…" };
  if (progress > 0 && progress < 100) {
    return {
      state: "downloading",
      label: `Loading ${Math.round(progress)}%`,
    };
  }
  return { state: "missing", label: "Downloads on first use" };
}
