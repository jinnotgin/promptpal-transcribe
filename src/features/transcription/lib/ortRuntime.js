/**
 * Shared onnxruntime-web setup for model workers.
 */

/**
 * Point the WASM backend at the CDN build matching the installed version and
 * use threads only when cross-origin isolation provides SharedArrayBuffer.
 * @param {typeof import('onnxruntime-web')} ort
 */
export function configureOrtWasm(ort) {
  const env = /** @type {any} */ (ort).env;
  const version = env?.versions?.common || "1.30.0";
  if (env?.wasm && !env.wasm.wasmPaths) {
    env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
  }
  if (env?.wasm) {
    env.wasm.numThreads =
      typeof SharedArrayBuffer === "undefined"
        ? 1
        : Math.max(1, (navigator.hardwareConcurrency || 4) - 2);
    env.wasm.proxy = false;
  }
}

/**
 * @param {'webgpu' | 'wasm'} runtime
 * @returns {string[]}
 */
export function executionProvidersFor(runtime) {
  return runtime === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
}
