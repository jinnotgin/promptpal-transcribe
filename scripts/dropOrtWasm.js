import fs from "node:fs";
import path from "node:path";

/**
 * onnxruntime-web references its WASM binaries relative to its own module,
 * so Vite copies one 24-28 MB file into the build for each ONNX Runtime copy.
 * The app never loads them: every worker (and parakeet.js) sets
 * `ort.env.wasm.wasmPaths` to jsDelivr before creating a session, and ONNX
 * Runtime then fetches both the loader and the binary from there. Dropping
 * them keeps every file under static hosts' size limits, such as Cloudflare
 * Pages' 25 MiB.
 */
const ORT_WASM = /^ort-wasm-.*\.wasm$/;

/**
 * Remove onnxruntime-web WASM binaries from a build's assets folder.
 * @param {string} outDir
 * @returns {string[]} the removed file names
 */
export function removeOrtWasm(outDir) {
  const assetsDir = path.join(outDir, "assets");
  if (!fs.existsSync(assetsDir)) return [];
  const removed = fs
    .readdirSync(assetsDir)
    .filter((name) => ORT_WASM.test(name));
  for (const name of removed) fs.rmSync(path.join(assetsDir, name));
  return removed;
}

/**
 * Worker bundles write their assets separately, so remove the files once the
 * whole build is on disk.
 * @returns {import('vite').Plugin}
 */
export function dropOrtWasm() {
  /** @type {string} */
  let outDir;
  return {
    name: "drop-ort-wasm",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const removed = removeOrtWasm(outDir);
      if (removed.length) {
        this.info?.(
          `removed ${removed.length} onnxruntime-web WASM file(s) loaded from jsDelivr at runtime`,
        );
      }
    },
  };
}
